import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StoreEntry = {
  value: number;
  expiresAt: number | null;
};

const store = new Map<string, StoreEntry>();

const getEntry = (key: string) => {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }

  return entry;
};

const redisMock = {
  get: vi.fn(async (key: string) => {
    const entry = getEntry(key);
    return entry ? String(entry.value) : null;
  }),
  pipeline: vi.fn(() => {
    const operations: Array<() => [null, number]> = [];

    return {
      incr(key: string) {
        operations.push(() => {
          const entry = getEntry(key);
          const nextValue = (entry?.value ?? 0) + 1;
          store.set(key, {
            value: nextValue,
            expiresAt: entry?.expiresAt ?? null,
          });
          return [null, nextValue];
        });
        return this;
      },
      expire(key: string, seconds: number) {
        operations.push(() => {
          const entry = getEntry(key);
          if (!entry) {
            return [null, 0];
          }

          entry.expiresAt = Date.now() + seconds * 1000;
          return [null, 1];
        });
        return this;
      },
      exec: vi.fn(async () => operations.map((operation) => operation())),
    };
  }),
};

vi.mock("~/server/redis/redis", () => ({
  redis: redisMock,
}));

describe("rate limit helpers", () => {
  beforeEach(() => {
    store.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a full window as blocked when checking", async () => {
    store.set("test:1773014400000", {
      value: 1,
      expiresAt: Date.now() + 5_000,
    });

    const { checkRateLimit } = await import("~/server/rate-limit");
    const result = await checkRateLimit({
      maxRequests: 1,
      windowMs: 5_000,
      keyPrefix: "test",
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.totalHits).toBe(1);
    expect(result.resetTime).toBe(1773014405000);
  });

  it("marks requests over the limit after recording", async () => {
    const { recordRateLimit } = await import("~/server/rate-limit");
    const config = {
      maxRequests: 1,
      windowMs: 5_000,
      keyPrefix: "record",
    };

    const first = await recordRateLimit(config);
    const second = await recordRateLimit(config);

    expect(first.allowed).toBe(true);
    expect(first.totalHits).toBe(1);
    expect(second.allowed).toBe(false);
    expect(second.totalHits).toBe(2);
  });

  it("waits for the next window before allowing another slot", async () => {
    const { waitForRateLimitSlot } = await import("~/server/rate-limit");
    const config = {
      maxRequests: 1,
      maxRetries: 2,
      windowMs: 5_000,
      keyPrefix: "global",
    };

    const first = await waitForRateLimitSlot(config);
    expect(first.allowed).toBe(true);
    expect(first.totalHits).toBe(1);

    let resolved = false;
    const secondPromise = waitForRateLimitSlot(config).then((result) => {
      resolved = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const second = await secondPromise;

    expect(resolved).toBe(true);
    expect(second.allowed).toBe(true);
    expect(second.totalHits).toBe(1);
    expect(await redisMock.get("global:1773014400000")).toBeNull();
    expect(await redisMock.get("global:1773014405000")).toBe("1");
  });
});

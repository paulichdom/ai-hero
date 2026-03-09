import { setTimeout as sleep } from "node:timers/promises";
import { redis } from "~/server/redis/redis";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  keyPrefix?: string;
  maxRetries?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  totalHits: number;
  retry: () => Promise<boolean>;
}

const DEFAULT_KEY_PREFIX = "rate_limit";
const DEFAULT_MAX_RETRIES = 3;

const getWindowState = ({
  windowMs,
  keyPrefix = DEFAULT_KEY_PREFIX,
}: Pick<RateLimitConfig, "windowMs" | "keyPrefix">) => {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetTime = windowStart + windowMs;

  return {
    key: `${keyPrefix}:${windowStart}`,
    resetTime,
    expiresInSeconds: Math.max(1, Math.ceil((resetTime - now) / 1000)),
  };
};

const waitForNextWindow = async (
  config: RateLimitConfig,
  initialResetTime: number,
): Promise<boolean> => {
  let attemptsRemaining = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  let nextResetTime = initialResetTime;

  while (attemptsRemaining > 0) {
    const waitTime = nextResetTime - Date.now();
    if (waitTime > 0) {
      await sleep(waitTime);
    }

    const retryResult = await checkRateLimit(config);
    if (retryResult.allowed) {
      return true;
    }

    nextResetTime = retryResult.resetTime;
    attemptsRemaining -= 1;
  }

  return false;
};

const buildRateLimitResult = (
  config: RateLimitConfig,
  totalHits: number,
  resetTime: number,
  allowWhenAtLimit: boolean,
): RateLimitResult => {
  const allowed = allowWhenAtLimit
    ? totalHits <= config.maxRequests
    : totalHits < config.maxRequests;

  return {
    allowed,
    remaining: Math.max(0, config.maxRequests - totalHits),
    resetTime,
    totalHits,
    retry: allowed
      ? async () => true
      : async () => waitForNextWindow(config, resetTime),
  };
};

export async function recordRateLimit(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const { key, resetTime, expiresInSeconds } = getWindowState(config);

  try {
    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, expiresInSeconds);

    const results = await pipeline.exec();
    if (!results) {
      throw new Error("Redis pipeline execution failed");
    }

    const totalHits = Number(results[0]?.[1] ?? 0);
    return buildRateLimitResult(config, totalHits, resetTime, true);
  } catch (error) {
    console.error("Rate limit recording failed:", error);
    throw error;
  }
}

export async function checkRateLimit(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const { key, resetTime } = getWindowState(config);

  try {
    const currentCount = await redis.get(key);
    const totalHits = currentCount ? Number.parseInt(currentCount, 10) : 0;

    return buildRateLimitResult(config, totalHits, resetTime, false);
  } catch (error) {
    console.error("Rate limit check failed:", error);

    return {
      allowed: true,
      remaining: Math.max(0, config.maxRequests - 1),
      resetTime,
      totalHits: 0,
      retry: async () => true,
    };
  }
}

export async function waitForRateLimitSlot(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const currentStatus = await checkRateLimit(config);

  if (!currentStatus.allowed) {
    const isAllowed = await currentStatus.retry();
    if (!isAllowed) {
      return currentStatus;
    }
  }

  while (true) {
    const recordedStatus = await recordRateLimit(config);
    if (recordedStatus.allowed) {
      return recordedStatus;
    }

    const isAllowed = await recordedStatus.retry();
    if (!isAllowed) {
      return recordedStatus;
    }
  }
}

import type { Message } from "ai";
import { streamText, createDataStreamResponse } from "ai";
import { model } from "~/model";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";
import { z } from "zod";
import { db } from "~/server/db";
import { userRequests, users } from "~/server/db/schema";
import { and, eq, gte } from "drizzle-orm";

export const maxDuration = 60;
export const REQUESTS_PER_DAY = 2;

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Fetch user from DB to get isAdmin
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id));
  if (!user) {
    return new Response("User not found", { status: 401 });
  }

  // Rate limit: 100 requests per day for non-admins
  const isAdmin = user.isAdmin;
  if (!isAdmin) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const requestsToday = await db
      .select({ count: userRequests.id })
      .from(userRequests)
      .where(
        and(
          eq(userRequests.userId, user.id),
          gte(userRequests.requestedAt, startOfDay),
        ),
      );
    const count = requestsToday.length;
    if (count >= REQUESTS_PER_DAY) {
      return new Response("Rate limit exceeded", { status: 429 });
    }
  }

  // Record the request
  await db.insert(userRequests).values({ userId: user.id });

  const body = (await request.json()) as {
    messages: Array<Message>;
  };

  return createDataStreamResponse({
    execute: async (dataStream) => {
      const { messages } = body;

      const result = streamText({
        model,
        messages,
        tools: {
          searchWeb: {
            parameters: z.object({
              query: z.string().describe("The query to search the web for"),
            }),
            execute: async ({ query }, { abortSignal }) => {
              const results = await searchSerper(
                { q: query, num: 10 },
                abortSignal,
              );
              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
              }));
            },
          },
        },
        system: `You are an AI assistant with access to a web search tool. For every user query, always use the searchWeb tool to find up-to-date information. Always cite your sources with inline markdown links, e.g. [source](url), for any factual statements or answers you provide.`,
        maxSteps: 10,
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occured!";
    },
  });
}

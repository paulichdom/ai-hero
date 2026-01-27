import {
  appendResponseMessages,
  createDataStreamResponse,
  streamText,
  type Message,
} from "ai";
import { randomUUID } from "node:crypto";
import { Langfuse } from "langfuse";
import { z } from "zod";
import { env } from "~/env";
import { model } from "~/model";
import { upsertChat } from "~/server/chat-helpers";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { chats, userRequests, users } from "~/server/db/schema";
import { crawlMultipleUrls } from "~/server/crawler";
import { cacheWithRedis } from "~/server/redis/redis";
import { searchSerper } from "~/serper";
import { bulkCrawlWebsites } from "~/crawler";
import { and, eq, gte } from "drizzle-orm";

export const maxDuration = 60;
export const REQUESTS_PER_DAY = 2;

const langfuse = new Langfuse({
  environment: env.NODE_ENV,
});

const cachedScrapePages = cacheWithRedis("scrapePagesTool", crawlMultipleUrls);

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
    messages: Message[];
    chatId?: string;
    isNewChat?: boolean;
  };

  const { messages, chatId, isNewChat = false } = body;
  const currentChatId = chatId ?? randomUUID();

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  if (!isNewChat && !chatId) {
    return new Response("Chat ID required", { status: 400 });
  }

  if (isNewChat) {
    await upsertChat({
      userId: user.id,
      chatId: currentChatId,
      title: messages[messages.length - 1]!.content.substring(0, 255) + "...",
      messages: messages,
    });
  } else {
    // Check if a chat exists and belongs to a user
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, currentChatId),
    });
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  const trace = langfuse.trace({
    sessionId: currentChatId,
    name: "chat",
    userId: session.user.id,
  });

  return createDataStreamResponse({
    async execute(dataStream) {
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: currentChatId,
        });
      }
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
                { q: query as string, num: 10 },
                abortSignal,
              );
              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
              }));
            },
          },
          scrapePages: {
            parameters: z.object({
              urls: z
                .array(z.string().url())
                .describe("The URLs of the pages to scrape"),
            }),
            execute: async ({ urls }) => {
              const result = await bulkCrawlWebsites({ urls });

              if (result.success) {
                return result.results.map((r) => ({
                  url: r.url,
                  content: r.result.data,
                }));
              }

              // Return both successful results and errors
              return result.results.map((r) => ({
                url: r.url,
                content: r.result.success ? r.result.data : null,
                error: r.result.success ? null : r.result.error,
              }));
            },
          },
          scrapePages: {
            parameters: z.object({
              urls: z
                .array(z.string().url("A full URL to scrape"))
                .min(1, "Provide at least one URL"),
              maxRetries: z
                .number()
                .int()
                .min(1)
                .max(5)
                .optional()
                .describe("How many times to retry crawling on failures"),
            }),
            execute: async ({ urls, maxRetries }) => {
              const result = await cachedScrapePages({ urls, maxRetries });
              return result;
            },
          },
        },
        onFinish: async ({ response }) => {
          try {
            const responseMessages = response.messages;

            const updatedMessages = appendResponseMessages({
              messages,
              responseMessages,
            });

            const userMessage = updatedMessages.findLast((m) => m.role === "user");
            if (!userMessage) {
              return;
            }

            // Upsert chat with updated messages
            await upsertChat({
              userId: session.user.id,
              chatId: currentChatId,
              title: userMessage.content.substring(0, 255) + "...",
              messages: updatedMessages,
            });
          } finally {
            await langfuse.flushAsync();
          }
        },
        system: `You are an AI assistant with access to web search and page scraping tools.

## Available Tools

### searchWeb
Use this tool to search the web for information. For every user query, always use the searchWeb tool first to find up-to-date information.

### scrapePages
Use this tool to get the full content of web pages. You MUST use this tool after every searchWeb call to get the complete content from the most relevant results. Never rely solely on search snippets - always scrape the pages to get full details.

## Guidelines
- Always cite your sources with inline markdown links, e.g. [source](url), for any factual statements or answers you provide.
- ALWAYS follow this workflow: 1) Search the web, 2) Scrape 4-6 of the most relevant pages, 3) Provide your answer based on the full content.
- When scraping, select a DIVERSE set of sources - mix different websites, perspectives, and source types (e.g., official docs, blogs, news, forums) to provide comprehensive and balanced information.
- Do not scrape multiple pages from the same domain when better alternatives exist.
- If scraping fails for a URL, inform the user and try to work with the available information.
- Do not skip the scraping step. Search snippets are not sufficient for providing accurate, comprehensive answers.`,
        maxSteps: 10,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "deep-search-chat-agent",
          metadata: {
            langfuseTraceId: trace.id,
          },
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occurred!";
    },
  });
}

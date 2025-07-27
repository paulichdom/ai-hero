import {
  appendResponseMessages,
  createDataStreamResponse,
  streamText,
  type Message,
} from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { model } from "~/model";
import { upsertChat } from "~/server/chat-helpers";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { chats, userRequests, users } from "~/server/db/schema";
import { searchSerper } from "~/serper";
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
    messages: Message[];
    chatId: string;
    isNewChat?: boolean;
  };

  const { messages, chatId, isNewChat = false } = body;

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  if (isNewChat) {
    await upsertChat({
      userId: user.id,
      chatId: chatId,
      title: messages[messages.length - 1]!.content.substring(0, 255) + "...",
      messages: messages,
    });
  } else {
    // Check if a chat exists and belongs to a user
    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, chatId),
    });
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  return createDataStreamResponse({
    async execute(dataStream) {
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: chatId,
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
        },
        onFinish: async ({ response }) => {
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
            chatId: chatId ?? '',
            title: userMessage.content.substring(0, 255) + '...',
            messages: updatedMessages,
          });
        },
        system: `You are an AI assistant with access to a web search tool. For every user query, always use the searchWeb tool to find up-to-date information. Always cite your sources with inline markdown links, e.g. [source](url), for any factual statements or answers you provide.`,
        maxSteps: 10,
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occurred!";
    },
  });
}

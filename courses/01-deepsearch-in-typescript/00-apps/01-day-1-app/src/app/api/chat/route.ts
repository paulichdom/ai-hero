import {
  appendResponseMessages,
  createDataStreamResponse,
  type Message,
} from "ai";
import { randomUUID } from "node:crypto";
import { Langfuse } from "langfuse";
import { streamFromDeepSearch } from "~/deep-search";
import { env } from "~/env";
import { upsertChat } from "~/server/chat-helpers";
import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { chats, userRequests, users } from "~/server/db/schema";
import {
  checkRateLimit,
  type RateLimitConfig,
  waitForRateLimitSlot,
} from "~/server/rate-limit";
import { and, eq, gte } from "drizzle-orm";

export const maxDuration = 60;
export const REQUESTS_PER_DAY = 2;
const GLOBAL_LLM_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 1,
  maxRetries: 3,
  windowMs: 20_000,
  keyPrefix: "global_llm",
};

const langfuse = new Langfuse({
  environment: env.NODE_ENV,
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const trace = langfuse.trace({
    name: "chat",
    userId: session.user.id,
  });

  // Fetch user from DB to get isAdmin
  const fetchUserByIdSpan = trace.span({
    name: "fetch-user-by-id",
    input: {
      userId: session.user.id,
    },
  });
  let user: typeof users.$inferSelect | undefined;
  try {
    [user] = await db.select().from(users).where(eq(users.id, session.user.id));
    fetchUserByIdSpan.end({
      output: {
        found: !!user,
        isAdmin: user?.isAdmin ?? null,
      },
    });
  } catch (error) {
    fetchUserByIdSpan.end({
      output: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  if (!user) {
    return new Response("User not found", { status: 401 });
  }

  // Rate limit: 100 requests per day for non-admins
  const isAdmin = user.isAdmin;
  if (!isAdmin) {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const countUserRequestsTodaySpan = trace.span({
      name: "count-user-requests-today",
      input: {
        userId: user.id,
        startOfDayUtc: startOfDay.toISOString(),
      },
    });
    let count = 0;
    try {
      const requestsToday = await db
        .select({ count: userRequests.id })
        .from(userRequests)
        .where(
          and(
            eq(userRequests.userId, user.id),
            gte(userRequests.requestedAt, startOfDay),
          ),
        );
      count = requestsToday.length;
      countUserRequestsTodaySpan.end({
        output: {
          requestCount: count,
        },
      });
    } catch (error) {
      countUserRequestsTodaySpan.end({
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    if (count >= REQUESTS_PER_DAY) {
      return new Response("Rate limit exceeded", { status: 429 });
    }
  }

  // Record the request
  const insertUserRequestSpan = trace.span({
    name: "insert-user-request",
    input: {
      userId: user.id,
    },
  });
  try {
    await db.insert(userRequests).values({ userId: user.id });
    insertUserRequestSpan.end({
      output: {
        inserted: true,
      },
    });
  } catch (error) {
    insertUserRequestSpan.end({
      output: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  const body = (await request.json()) as {
    messages: Message[];
    chatId?: string;
    isNewChat?: boolean;
  };

  const { messages, chatId, isNewChat = false } = body;

  if (!messages.length) {
    return new Response("No messages provided", { status: 400 });
  }

  if (!isNewChat && !chatId) {
    return new Response("Chat ID required", { status: 400 });
  }

  const currentChatId = chatId ?? randomUUID();
  trace.update({
    sessionId: currentChatId,
  });

  if (isNewChat) {
    const upsertNewChatSpan = trace.span({
      name: "upsert-new-chat",
      input: {
        userId: user.id,
        chatId: currentChatId,
        messageCount: messages.length,
      },
    });
    try {
      await upsertChat({
        userId: user.id,
        chatId: currentChatId,
        title: messages[messages.length - 1]!.content.substring(0, 255) + "...",
        messages: messages,
      });
      upsertNewChatSpan.end({
        output: {
          upserted: true,
        },
      });
    } catch (error) {
      upsertNewChatSpan.end({
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  } else {
    // Check if a chat exists and belongs to a user
    const findExistingChatSpan = trace.span({
      name: "find-existing-chat",
      input: {
        chatId: currentChatId,
      },
    });
    let chat:
      | Awaited<ReturnType<typeof db.query.chats.findFirst>>
      | undefined;
    try {
      chat = await db.query.chats.findFirst({
        where: eq(chats.id, currentChatId),
      });
      findExistingChatSpan.end({
        output: {
          found: !!chat,
          userId: chat?.userId ?? null,
        },
      });
    } catch (error) {
      findExistingChatSpan.end({
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    if (!chat || chat.userId !== session.user.id) {
      return new Response("Chat not found or unauthorized", { status: 404 });
    }
  }

  return createDataStreamResponse({
    async execute(dataStream) {
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId: currentChatId,
        });
      }

      const initialRateLimitStatus = await checkRateLimit(GLOBAL_LLM_RATE_LIMIT);
      if (!initialRateLimitStatus.allowed) {
        dataStream.writeData({
          type: "RATE_LIMIT_WAITING",
          resetTime: initialRateLimitStatus.resetTime,
        });
      }

      const waitForGlobalRateLimitSpan = trace.span({
        name: "wait-for-global-rate-limit",
        input: GLOBAL_LLM_RATE_LIMIT,
      });
      try {
        const rateLimitStatus = await waitForRateLimitSlot(GLOBAL_LLM_RATE_LIMIT);
        if (!rateLimitStatus.allowed) {
          throw new Error("Rate limit exceeded");
        }

        waitForGlobalRateLimitSpan.end({
          output: {
            allowed: rateLimitStatus.allowed,
            remaining: rateLimitStatus.remaining,
            resetTime: new Date(rateLimitStatus.resetTime).toISOString(),
            totalHits: rateLimitStatus.totalHits,
          },
        });

        if (!initialRateLimitStatus.allowed) {
          dataStream.writeData({
            type: "RATE_LIMIT_RESOLVED",
          });
        }
      } catch (error) {
        waitForGlobalRateLimitSpan.end({
          output: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }

      const result = streamFromDeepSearch({
        messages,
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
            const upsertFinalChatMessagesSpan = trace.span({
              name: "upsert-final-chat-messages",
              input: {
                userId: session.user.id,
                chatId: currentChatId,
                messageCount: updatedMessages.length,
              },
            });
            try {
              await upsertChat({
                userId: session.user.id,
                chatId: currentChatId,
                title: userMessage.content.substring(0, 255) + "...",
                messages: updatedMessages,
              });
              upsertFinalChatMessagesSpan.end({
                output: {
                  upserted: true,
                },
              });
            } catch (error) {
              upsertFinalChatMessagesSpan.end({
                output: {
                  error: error instanceof Error ? error.message : String(error),
                },
              });
              throw error;
            }
          } finally {
            await langfuse.flushAsync();
          }
        },
        telemetry: {
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

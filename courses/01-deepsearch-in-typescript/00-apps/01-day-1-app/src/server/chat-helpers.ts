import { db } from "./db";
import { chats, messages } from "./db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Message as AIMessage } from "ai";

export const upsertChat = async (opts: {
  userId: string;
  chatId: string;
  title: string;
  messages: AIMessage[];
}) => {
  // Check if chat exists and belongs to user
  const chat = await db.query.chats.findFirst({
    where: and(eq(chats.id, opts.chatId), eq(chats.userId, opts.userId)),
  });

  if (!chat) {
    // Check if chatId is already used by another user
    const existingChat = await db.query.chats.findFirst({
      where: eq(chats.id, opts.chatId),
    });
    if (existingChat && existingChat.userId !== opts.userId) {
      throw new Error("Chat ID already exists for a different user.");
    }
    // Create new chat
    await db.insert(chats).values({
      id: opts.chatId,
      title: opts.title,
      userId: opts.userId,
    });
  } else {
    // Update title if changed
    if (chat.title !== opts.title) {
      await db.update(chats).set({ title: opts.title }).where(eq(chats.id, opts.chatId));
    }
    // Delete existing messages
    await db.delete(messages).where(eq(messages.chatId, opts.chatId));
  }

  // Insert new messages
  if (opts.messages.length > 0) {
    await db.insert(messages).values(
      opts.messages.map((msg, i) => ({
        id: nanoid(),
        chatId: opts.chatId,
        role: msg.role,
        parts: msg.parts,
        order: i,
      }))
    );
  }
};

export const getChat = async (opts: { userId: string; chatId: string }) => {
  const chat = await db.query.chats.findFirst({
    where: and(eq(chats.id, opts.chatId), eq(chats.userId, opts.userId)),
    with: {
      messages: {
        orderBy: (messages, { asc }) => [asc(messages.order)],
      },
    },
  });
  return chat;
};

export const getChats = async (opts: { userId: string }) => {
  return db.query.chats.findMany({
    where: eq(chats.userId, opts.userId),
    columns: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: (chats, { desc }) => [desc(chats.updatedAt)],
  });
}; 
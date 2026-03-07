import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { auth } from "~/server/auth/index.ts";
import { ChatPage } from "./chat.tsx";
import { AuthButton } from "../components/auth-button.tsx";
import { getChats, getChat } from "~/server/chat-helpers";
import type { Message } from "ai";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const session = await auth();
  const userName = session?.user?.name ?? "Guest";
  const isAuthenticated = !!session?.user;
  const { id: chatIdFromUrl } = await searchParams;

  // Generate a stable chatId - either from URL or create new one
  const chatId = chatIdFromUrl ?? crypto.randomUUID();
  const isNewChat = !chatIdFromUrl;

  // Fetch chats for sidebar if user is authenticated
  const chats =
    isAuthenticated && session?.user?.id
      ? await getChats({ userId: session.user.id })
      : [];

  // Fetch specific chat if we're loading an existing chat
  let initialMessages: Message[] = [];
  if (!isNewChat && isAuthenticated && session?.user?.id) {
    const chat = await getChat({ userId: session.user.id, chatId });
    if (chat?.messages) {
      initialMessages = chat.messages.map((msg) => ({
        id: msg.id,
        // msg.role is typed as string, so we
        // need to cast it to the correct type
        role: msg.role as "user" | "assistant",
        // msg.parts is typed as unknown[], so we
        // need to cast it to the correct type and ensure it's an array
        parts: Array.isArray(msg.parts) ? (msg.parts as Message["parts"]) : [],
        // content is not persisted, so we can
        // safely pass an empty string, because
        // parts are always present, and the AI SDK
        // will use the parts to construct the content
        content: "",
      }));
    }
  }

  return (
    <div className="flex h-screen bg-gray-950">
      {/* Sidebar */}
      <div className="flex w-64 flex-col border-r border-gray-700 bg-gray-900">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-400">Your Chats</h2>
            {isAuthenticated && (
              <Link
                href="/"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
                title="New Chat"
              >
                <PlusIcon className="h-5 w-5" />
              </Link>
            )}
          </div>
        </div>
        <div className="-mt-1 flex-1 space-y-2 overflow-y-auto px-4 pt-1 scrollbar-thin scrollbar-track-gray-800 scrollbar-thumb-gray-600">
          {chats.length > 0 ? (
            chats.map((chat) => (
              <div key={chat.id} className="flex items-center gap-2">
                <Link
                  href={`/?id=${chat.id}`}
                  className={`flex-1 rounded-lg p-3 text-left text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-400 ${
                    chat.id === chatIdFromUrl
                      ? "bg-gray-700"
                      : "hover:bg-gray-750 bg-gray-800"
                  }`}
                >
                  {chat.title}
                </Link>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-500">
              {isAuthenticated
                ? "No chats yet. Start a new conversation!"
                : "Sign in to start chatting"}
            </p>
          )}
        </div>
        <div className="p-4">
          <AuthButton
            isAuthenticated={isAuthenticated}
            userImage={session?.user?.image}
          />
        </div>
      </div>

      <ChatPage
        key={chatId}
        userName={userName}
        chatId={chatId}
        isNewChat={isNewChat}
        initialMessages={initialMessages}
      />
    </div>
  );
}

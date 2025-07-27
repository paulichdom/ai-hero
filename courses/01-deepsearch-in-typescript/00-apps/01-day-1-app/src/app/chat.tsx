"use client";

import { ChatMessage } from "~/components/chat-message";
import { SignInModal } from "~/components/sign-in-modal";
import { useChat } from "@ai-sdk/react";
import { Square } from "lucide-react";
import React, { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { isNewChatCreated } from "./is-new-chat-created";
import type { Message } from "ai";

interface ChatProps {
  userName: string;
  chatId: string | undefined;
  initialMessages?: Message[];
}

export const ChatPage = ({ userName, chatId, initialMessages }: ChatProps) => {
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    data,
  } = useChat({
    body: {
      chatId,
    },
    initialMessages: initialMessages ?? [],
  });
  const { data: session } = useSession();
  const [showSignIn, setShowSignIn] = React.useState(false);
  const router = useRouter();

  useEffect(() => {
    const lastDataItem = data?.[data.length - 1];

    if (isNewChatCreated(lastDataItem)) {
      router.push(`/?id=${lastDataItem.chatId}`);
    }
  }, [data, router]);

  // Custom submit handler
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!session) {
      setShowSignIn(true);
      return;
    }
    handleSubmit(e);
  };

  return (
    <>
      <div className="flex flex-1 flex-col">
        <div
          className="mx-auto w-full max-w-[65ch] flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-track-gray-800 scrollbar-thumb-gray-600 hover:scrollbar-thumb-gray-500"
          role="log"
          aria-label="Chat messages"
        >
          {messages.map((message, index) => {
            return (
              <ChatMessage
                key={index}
                parts={message.parts ?? []}
                role={message.role}
                userName={userName}
              />
            );
          })}
          {error && (
            <ChatMessage
              key="error-message"
              parts={[
                {
                  type: "text",
                  text:
                    typeof error === "string"
                      ? error
                      : error.message || "An error occurred.",
                },
              ]}
              role="system"
              userName="System"
            />
          )}
        </div>

        <div className="border-t border-gray-700">
          <form onSubmit={onSubmit} className="mx-auto max-w-[65ch] p-4">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Say something..."
                autoFocus
                aria-label="Chat input"
                className="flex-1 rounded border border-gray-700 bg-gray-800 p-2 text-gray-200 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="rounded bg-gray-700 px-4 py-2 text-white hover:bg-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50 disabled:hover:bg-gray-700"
              >
                {isLoading ? (
                  <Square className="size-4 animate-spin" />
                ) : (
                  "Send"
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      <SignInModal isOpen={showSignIn} onClose={() => setShowSignIn(false)} />
    </>
  );
};

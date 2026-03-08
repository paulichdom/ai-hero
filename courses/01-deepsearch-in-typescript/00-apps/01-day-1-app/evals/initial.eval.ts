import { evalite } from "evalite";
import type { Message } from "ai";
import { askDeepSearch } from "~/deep-search";

evalite("Deep Search Eval", {
  data: async (): Promise<{ input: Message[] }[]> => {
    return [
      {
        input: [
          {
            id: "1",
            role: "user",
            content: "What is the latest version of TypeScript?",
          },
        ],
      },
      {
        input: [
          {
            id: "2",
            role: "user",
            content: "What are the main features of Next.js 15?",
          },
        ],
      },
      /* {
        input: [
          {
            id: "3",
            role: "user",
            content: "Compare React Server Components and client components.",
          },
        ],
      },
      {
        input: [
          {
            id: "4",
            role: "user",
            content:
              "What changed in Node.js 22 and should I upgrade from Node.js 20?",
          },
        ],
      },
      {
        input: [
          {
            id: "5",
            role: "user",
            content: "Best practices for TypeScript project structure in 2026.",
          },
        ],
      },
      {
        input: [
          {
            id: "6",
            role: "user",
            content:
              "Give me a concise summary of current OpenTelemetry support in Next.js.",
          },
        ],
      },
      {
        input: [
          {
            id: "7",
            role: "user",
            content:
              "What are the top alternatives to Redis for caching and what are their tradeoffs?",
          },
        ],
      }, */
    ];
  },
  task: async (input) => {
    return askDeepSearch(input);
  },
  scorers: [
    {
      name: "Contains Links",
      description: "Checks if the output contains any markdown links.",
      scorer: ({ output }) => {
        const containsLinks = /\[[^\]]+\]\([^)]+\)/.test(output);
        return containsLinks ? 1 : 0;
      },
    },
  ],
});

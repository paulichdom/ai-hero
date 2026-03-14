import { evalite } from "evalite";
import type { Message } from "ai";
import { askDeepSearch } from "~/deep-search";
import { Factuality } from "./scorers/factuality";

evalite("Deep Search Eval", {
  data: async (): Promise<{ input: Message[]; expected: string }[]> => {
    return [
      // Basic recent-knowledge questions
      {
        input: [
          {
            id: "1",
            role: "user",
            content: "What is the latest stable version of TypeScript?",
          },
        ],
        expected:
          "The latest stable TypeScript release is TypeScript 5.9, announced on August 1, 2025.",
      },
      {
        input: [
          {
            id: "2",
            role: "user",
            content: "What are the main features of Next.js 15?",
          },
        ],
        expected: `
@next/codemod CLI: Easily upgrade to the latest Next.js and React versions.
Async Request APIs (Breaking): Incremental step towards a simplified rendering and caching model.
Caching Semantics (Breaking): fetch requests, GET Route Handlers, and client navigations are no longer cached by default.
React 19 Support: Support for React 19, React Compiler (Experimental), and hydration error improvements.
Turbopack Dev (Stable): Performance and stability improvements.
Static Indicator: New visual indicator shows static routes during development.
unstable_after API (Experimental): Execute code after a response finishes streaming.
instrumentation.js API (Stable): New API for server lifecycle observability.
Enhanced Forms (next/form): Enhance HTML forms with client-side navigation.
next.config: TypeScript support for next.config.ts.
Self-hosting Improvements: More control over Cache-Control headers.
Server Actions Security: Unguessable endpoints and removal of unused actions.
Bundling External Packages (Stable): New config options for App and Pages Router.
ESLint 9 Support: Added support for ESLint 9.
Development and Build Performance: Improved build times and Faster Fast Refresh.
`,
      },
      {
        input: [
          {
            id: "3",
            role: "user",
            content: "What changed in Node.js 24.0.0?",
          },
        ],
        expected: `
Node.js 24.0.0 was released on May 6, 2025.
Headline changes include V8 13.6, npm 11, AsyncLocalStorage using AsyncContextFrame by default, URLPattern becoming globally available, permission model improvements with --permission, test runner enhancements, and Undici 7.
`,
      },
      // Multi-hop recent-knowledge questions
      {
        input: [
          {
            id: "4",
            role: "user",
            content:
              "Which was released later, Next.js 15 or TypeScript 5.9, and by about how long?",
          },
        ],
        expected: `
Next.js 15 was released on October 21, 2024.
TypeScript 5.9 was released on August 1, 2025.
TypeScript 5.9 came later, by roughly 9 months and 11 days.
`,
      },
      {
        input: [
          {
            id: "5",
            role: "user",
            content:
              "Compare the default changes introduced by Next.js 15 and TypeScript 5.9: what stopped being the default in Next.js, and what became the new default shape of tsc --init in TypeScript?",
          },
        ],
        expected: `
Next.js 15 removed several caching defaults: fetch requests, GET Route Handlers, and client navigations are no longer cached by default.
TypeScript 5.9 made tsc --init generate a smaller, more prescriptive tsconfig by default, including settings like module: nodenext, target: esnext, types: [], sourceMap, declaration, declarationMap, strict, jsx: react-jsx, verbatimModuleSyntax, isolatedModules, noUncheckedSideEffectImports, moduleDetection: force, and skipLibCheck.
`,
      },
      {
        input: [
          {
            id: "6",
            role: "user",
            content:
              "As of March 2026, if you want a production-ready stack using the latest stable TypeScript and the current Active LTS Node release, which versions are those, and which one was released more recently?",
          },
        ],
        expected: `
The latest stable TypeScript release is 5.9.
The current Active LTS Node release line is Node.js 24.x (codename Krypton).
TypeScript 5.9 was released on August 1, 2025, while Node.js 24.0.0 was first released on May 6, 2025, so TypeScript 5.9 is the more recent release.
`,
      },
    ];
  },
  task: async (input) => {
    return askDeepSearch(input);
  },
  scorers: [Factuality],
});

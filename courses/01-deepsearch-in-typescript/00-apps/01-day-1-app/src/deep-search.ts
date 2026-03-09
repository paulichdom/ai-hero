import {
  streamText,
  type Message,
  type TelemetrySettings,
} from "ai";
import { z } from "zod";
import { model } from "~/model";
import { crawlMultipleUrls } from "~/server/crawler";
import { cacheWithRedis } from "~/server/redis/redis";
import { searchSerper } from "~/serper";

const cachedScrapePages = cacheWithRedis("scrapePagesTool", crawlMultipleUrls);

const createSystemPrompt = () => {
  const currentDateTime = new Date();
  const currentDateTimeIso = currentDateTime.toISOString();
  const currentDateTimeUtc = currentDateTime.toUTCString();

  return `You are an AI assistant with access to web search and page scraping tools.

## Current Date and Time
- Current date and time (ISO 8601): ${currentDateTimeIso}
- Current date and time (UTC): ${currentDateTimeUtc}
- When the user asks for up-to-date, latest, current, today, or recent information, use this date/time context and include explicit dates in your search queries.

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
- Do not skip the scraping step. Search snippets are not sufficient for providing accurate, comprehensive answers.`;
};

export const streamFromDeepSearch = (opts: {
  messages: Message[];
  onFinish: Parameters<typeof streamText>[0]["onFinish"];
  telemetry: TelemetrySettings;
}) =>
  streamText({
    model,
    messages: opts.messages,
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
            publishedDate: result.date ?? null,
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
    onFinish: opts.onFinish,
    system: createSystemPrompt(),
    maxSteps: 10,
    experimental_telemetry: opts.telemetry,
  });

export async function askDeepSearch(messages: Message[]) {
  const result = streamFromDeepSearch({
    messages,
    onFinish: async () => {},
    telemetry: {
      isEnabled: false,
    },
  });

  await result.consumeStream();

  return await result.text;
}

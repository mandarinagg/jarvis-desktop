/**
 * Anthropic list prices in USD per million tokens (docs/CLAUDE_API.md §4.1, 2026-11).
 * Cache writes use the 5-minute TTL rate (1.25x input). Verify against the console before relying on them.
 */
import type { Usage } from "@jarvis/shared";

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  // Server-side refusal fallback targets (billed at their own rates).
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;

/** Unknown models are priced as the most expensive known one: the daily cap must never under-count. */
export function priceOf(model: string): Price {
  return PRICES[model] ?? { input: 5, output: 25, cacheRead: 0.5 };
}

export function costOf(model: string, u: Usage): number {
  const p = priceOf(model);
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

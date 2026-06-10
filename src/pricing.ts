import type { ModelPricing, Usage } from "./types.js";

/** Estimate cost (US$) for `usage` at the given per-1M-token `pricing`. */
export function estimateCost(usage: Usage, pricing: ModelPricing): number {
  return (
    ((usage.inputTokens ?? 0) * pricing.input +
      (usage.outputTokens ?? 0) * pricing.output +
      (usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? 0) +
      (usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? 0)) /
    1_000_000
  );
}

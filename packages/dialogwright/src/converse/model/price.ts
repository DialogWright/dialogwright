/** US dollars per million tokens, by the model id as a spec names it (`<provider>:<model>`), and where the price was read. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Where the price was read, and when (a page and a date). */
  source?: string;
}

/**
 * List prices, each read from its provider's own pricing page on the date given. A model whose price is not
 * here costs null, and the evaluation refuses it, since its budget would under-count. A price changes:
 * read the page again before a run that spends money.
 */
const PRICES = new Map<string, ModelPrice>([
  // The regular price (0.10 and 0.35 at its launch discount; new accounts get 100M free tokens), counted in full so a budget never under-counts.
  ['inception:mercury-3', { input: 0.2, output: 0.7, source: "Inception's pricing, the regular price (launch discount aside), read 2026-11-09 and 2026-11-11" }],
  // Prompts up to 100,000 tokens; over it, 0.50 and 2.50 (a converse call's prompt is far under it).
  ['anthropic:claude-haiku-5-5', { input: 0.1, output: 0.5, source: 'platform.claude.com/docs/en/about-claude/pricing, prompts up to 100,000 tokens, read 2026-11-11' }],
  ['anthropic:claude-sonnet-5-5', { input: 2, output: 10, source: 'platform.claude.com/docs/en/about-claude/pricing, read 2026-11-11' }],
  // Standard mode (the content is not used to train the provider's models), up to 200K input tokens. Muse Ember has no Contributor mode on the Model API.
  ['meta:muse-ember-1.0', { input: 0.1, output: 0.5, source: 'dev.meta.ai/docs/pricing-rate-limits, Standard mode, up to 200K input tokens, read 2026-11-11' }],
  ['meta:muse-spark-1.3', { input: 1.25, output: 4.25, source: 'dev.meta.ai/docs/pricing-rate-limits, Standard mode, read 2026-11-11' }],
  // OpenRouter's own listing (api/v1/models, and a model's endpoints for the host a spec pins).
  ['openrouter:openai/gpt-6-luna', { input: 0.1, output: 0.5, source: 'openrouter.ai/api/v1/models, read 2026-11-11' }],
  ['openrouter:google/gemini-3.8-flash', { input: 0.825, output: 4.125, source: 'openrouter.ai/api/v1/models, read 2026-11-11' }],
  ['openrouter:openai/gpt-oss-120b@groq', { input: 0.15, output: 0.6, source: 'openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints, its Groq endpoint, read 2026-11-11' }],
]);

/** Add the price of a model (an OpenRouter id, say) to the table: from its listing page, noted by the caller. */
export function addModelPrice(modelId: string, price: ModelPrice): void {
  PRICES.set(modelId, price);
}

/** The price of a model and where it was read, or null where it is not known. */
export function priceOf(modelId: string): ModelPrice | null {
  return PRICES.get(modelId) ?? null;
}

/** The cost of a model's usage in US dollars, or null where its price is not known. */
export function costUsd(modelId: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const p = PRICES.get(modelId);
  return p === undefined ? null : (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}

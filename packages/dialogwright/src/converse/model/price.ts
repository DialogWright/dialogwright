/** US dollars per million tokens, by the model id as a spec names it (`<provider>:<model>`). */
export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES = new Map<string, ModelPrice>([
  // Inception's regular price for Mercury 3 (docs/guide/14-running-it.md, the render price table; 0.10 and 0.35 at its launch discount). Inception's pricing page, as of 2026-11-09.
  ['inception:mercury-3', { input: 0.2, output: 0.7 }],
  // Claude Haiku 5.5: the engine's default render price (render/types.ts DEFAULT_RENDER_PRICE), as of 2026-11-11.
  ['anthropic:claude-haiku-5-5', { input: 0.1, output: 0.5 }],
  // Claude Sonnet 5.5: the figure the bake-off's --price help gives as its example (harness-text/renderBakeoff.ts), 2026-11-11; confirm against Anthropic's pricing page before quoting a cost.
  ['anthropic:claude-sonnet-5-5', { input: 1, output: 5 }],
]);

/** Add the price of a model (an OpenRouter id, say) to the table: from its listing page, noted by the caller. */
export function addModelPrice(modelId: string, price: ModelPrice): void {
  PRICES.set(modelId, price);
}

/** The cost of a model's usage in US dollars, or null where its price is not known. */
export function costUsd(modelId: string, usage: { inputTokens: number; outputTokens: number }): number | null {
  const p = PRICES.get(modelId);
  return p === undefined ? null : (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000;
}

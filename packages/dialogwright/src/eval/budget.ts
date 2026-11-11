import { costUsd } from '../converse/model/price';

/** What a run has spent on the models it asks (the caller and the judge), so it can stop at a limit. */
export class Budget {
  private total = 0;
  private readonly unpriced = new Set<string>();

  constructor(private readonly limitUsd: number, private readonly warn: (line: string) => void = (l) => console.warn(l)) {}

  /** Adds a model's usage at its price; a model with no known price counts 0 and is warned of, once. */
  add(modelId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const c = costUsd(modelId, usage);
    if (c === null) {
      if (!this.unpriced.has(modelId)) {
        this.unpriced.add(modelId);
        this.warn(`WARNING: no price is known for ${modelId}: its cost counts as 0 and the budget under-counts`);
      }
      return;
    }
    this.total += c;
  }

  spent(): number {
    return this.total;
  }

  left(): number {
    return Math.max(0, this.limitUsd - this.total);
  }

  exceeded(): boolean {
    return this.total > this.limitUsd;
  }
}

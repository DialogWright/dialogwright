import type { RenderChannel, RenderSituation } from '../core/app/types';
import type { LineRole } from '../prompts/render';
import type { JevClient } from '../jev/types';

/**
 * Generated wording (design section 5): a line the app marks generated is worded by a model for the
 * moment, held to its fixed line's data and meaning by checks, and the fixed line is said whenever a
 * check fails, the model is slow or it errs. The core has decided before the renderer runs; generated
 * wording changes how a line is said, never what is decided.
 */

/** A data item a generated line must carry, exactly as it would be said (a display value, never an identifier). */
export interface SpeechItem {
  readonly name: string;
  readonly value: string;
}

/**
 * What the model is given to word one line: a speech act, never the conversation. No identifier (a
 * line that names one is never generated), no transcript, no tool result: the act, its goal, the fixed
 * line, the items it must carry, the caller's last words quoted as data, how frustrated they are, the
 * situation, the channel, the language and the style. For a line generated from collected content
 * (prompts.yaml's `from`), that content as data.
 */
export interface SpeechAct {
  /** What the line is for in its decision (prompts/render.ts LineRole). */
  readonly act: LineRole;
  /** What the line must do (prompts.yaml's goal). */
  readonly goal: string;
  /** The fixed line, as it would be said: the meaning, and the fallback. */
  readonly fixed: string;
  /** Whether the fixed line asks a question: a generated one must end in exactly one, else ask none. */
  readonly asks: boolean;
  /** The data items the line must carry, each word for word. */
  readonly items: readonly SpeechItem[];
  /** Collected content the line may summarize (prompts.yaml's `from`); absent for every other line. */
  readonly content?: readonly SpeechItem[];
  /** The caller's words on this turn, quoted as data; absent on a turn without words, or at a sensitive question. */
  readonly heard?: string;
  /** How frustrated the caller has been on this call: none, some (once), high (more than once). */
  readonly frustration: 'none' | 'some' | 'high';
  /** The situations the line is said in (first-ask or re-ask, after-correction, frustrated). */
  readonly situations: readonly RenderSituation[];
  readonly channel: RenderChannel;
  /** The language the call is in (a language tag). */
  readonly language: string;
  readonly style: {
    readonly persona: string;
    /** The most words the line may use, on this channel. */
    readonly words: number;
    readonly avoid: readonly string[];
  };
}

export interface RenderUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A model's wording of one line, before any check. */
export interface Generation {
  text: string;
  /** The model id that answered. */
  model: string;
  usage: RenderUsage;
  latencyMs: number;
  /** Where it came from: a model, a recorded cassette, or a fake (tests). */
  source: 'model' | 'recorded' | 'fake';
}

/** A render client's failure to word a line: a timeout, a transport or API error, a cassette with no line for it. */
export class RenderClientError extends Error {
  constructor(message: string, readonly kind: 'error' | 'cassette-miss' = 'error') {
    super(message);
    this.name = 'RenderClientError';
  }
}

/**
 * One line to word: its act (all a model is sent), the prompt id it is for, and its key (render/prompt.ts
 * renderKey: the act and its line), which a cassette records and replays by. A model is never sent the id.
 */
export interface RenderRequest {
  readonly promptId: string;
  readonly act: SpeechAct;
  readonly key: string;
}

/**
 * Words a line (render/providers.ts for OpenRouter and Anthropic; render/fake.ts for tests;
 * render/cassette.ts recording and replaying either). A failure rejects; the line is then said fixed.
 */
export interface RenderClient {
  /** The model asked, for a run's header and a cassette's file name. */
  readonly model: string;
  generate(req: RenderRequest, signal: AbortSignal): Promise<Generation>;
}

/** Why a line the app generates was said fixed instead of generated: a check that failed, or how the generation failed. */
export type RenderFallback =
  | 'empty' | 'format' | 'items' | 'foreign' | 'words' | 'question' | 'avoid' | 'drift'
  | 'timeout' | 'error' | 'cassette-miss' | 'drift-error';

/** Why a line the app generates was not tried on this turn (its fixed line said, no fallback). */
export type RenderSkip =
  /** RENDER_SHARE put the call in the group served fixed. */
  | 'share'
  /** Its `when` leaves out this situation or channel. */
  | 'when'
  /** The call's locale gives the line no goal. */
  | 'locale'
  /** The injection screen flagged the turn's words, or did not read them. */
  | 'screen'
  /** The line names an identifier. */
  | 'identifier';

/** One line the app generates, as said on a turn (TraceRecord.render.lines). */
export interface RenderLine {
  /** Its index in the turn's actions. */
  index: number;
  promptId: string;
  /** `generated`: the model's wording was said; `fixed`: the fixed line was. */
  mode: 'generated' | 'fixed';
  /** The fixed line, as it would be said. */
  fixed: string;
  /** The generated wording said; only when `mode` is generated. */
  said?: string;
  act: LineRole;
  situations: RenderSituation[];
  /** Why it was not tried (its fixed line said, nothing asked of a model). */
  skipped?: RenderSkip;
  /** Why the generation was not said: the check that failed, or how it failed. */
  fallback?: RenderFallback;
  /** The wording a check refused, for whoever reads the trace; never said. */
  refused?: string;
  /** How long the line's generation and checks took, ms. */
  ms?: number;
  usage?: RenderUsage;
  source?: Generation['source'];
}

/** What generated wording did on a turn (TraceRecord.render), only for an app that generates a line and a run with a renderer. */
export interface RenderRecord {
  /** The call's group (RENDER_SHARE): served generated, or served fixed. */
  group: 'generated' | 'fixed';
  /** The share of calls served generated (RENDER_SHARE), 0 to 100. */
  share: number;
  /** The model asked, when one was. */
  model?: string;
  lines: RenderLine[];
  /** What the generations cost, all lines together; the drift checks are the decision model's, in the record's own usage. */
  usage?: RenderUsage & { costUsd: number };
  /** How long the turn's rendering took, ms. */
  ms?: number;
}

/** A model's price, US dollars per million tokens. */
export interface RenderPrice {
  input: number;
  output: number;
}

/** How a run renders generated lines (RunOptions.renderer). Absent: every line is its fixed text. */
export interface Renderer {
  client: RenderClient;
  /** RENDER_SHARE: the share of calls (0 to 100) served generated, chosen per call; default 100. */
  share?: number;
  /** RENDER_TIMEOUT_MS: how long a turn waits for its generated lines, checks included, per channel; default 700 on voice, 1500 in a chat. */
  timeoutMs?: { voice: number; chat: number };
  /** The model's price, for the cost in the trace and Insights; default the default model's. */
  price?: RenderPrice;
  /**
   * The decision model client the drift check asks (`renderDrift`); default the run's own (RunOptions.client).
   * A test or a stub run passes a stub, so the check asks nothing of a model.
   */
  drift?: JevClient;
}

/** The default per-turn budget, ms, on each channel. */
export const DEFAULT_RENDER_TIMEOUT_MS = { voice: 700, chat: 1500 } as const;

/** The default model's price (Claude Haiku 5.5), US dollars per million tokens: what the cost is counted at unless RENDER_PRICE_* says otherwise. */
export const DEFAULT_RENDER_PRICE: RenderPrice = { input: 0.1, output: 0.5 };

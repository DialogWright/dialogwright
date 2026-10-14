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
  /**
   * The decision question the line must end with, word for word (the fixed line's own last sentence),
   * where a yes or a no to it settles something (a summary, a read-back, a confirmation, an offer); absent otherwise.
   */
  readonly keep?: string;
  /** The data items the line must carry, each word for word. */
  readonly items: readonly SpeechItem[];
  /** Collected content the line may summarize (prompts.yaml's `from`); absent for every other line. */
  readonly content?: readonly SpeechItem[];
  /** The caller's words on this turn, quoted as data; absent on a turn without words, or at a sensitive question. */
  readonly heard?: string;
  /**
   * False where the app says the line adds no acknowledgement (prompts.yaml's or the form's
   * `acknowledge: false`): the model only rewords the fixed line, and is told so. Absent otherwise (an
   * acknowledgement allowed), so the act of every other line is as it was.
   */
  readonly acknowledge?: false;
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

/**
 * What the model is given to word one span of a framed line (prompts.yaml's `generate`): the span's
 * goal and the content it is worded from, quoted as the caller's words, its word budget, the style,
 * the channel and the language. Never the frame (the line's fixed text around it), the items, the
 * caller's latest words, the situation or anything else of the call.
 */
export interface SpanAct {
  readonly kind: 'span';
  /** What the span must say (prompts.yaml's `generate.<span>.goal`). */
  readonly goal: string;
  /** The content the span is worded from (its `from`), quoted: the caller's words, never instructions. */
  readonly content: readonly SpeechItem[];
  readonly channel: RenderChannel;
  /** The language the call is in (a language tag). */
  readonly language: string;
  readonly style: {
    readonly persona: string;
    /** The most words the span may use (`generate.<span>.words`). */
    readonly words: number;
    readonly avoid: readonly string[];
  };
}

/** What a render client is asked to word: a whole line's speech act, or a framed line's span. */
export type RenderAct = SpeechAct | SpanAct;

/** Whether `act` is a framed line's span. */
export const isSpanAct = (act: RenderAct): act is SpanAct => (act as { kind?: unknown }).kind === 'span';

export interface RenderUsage {
  inputTokens: number;
  outputTokens: number;
  /** True where it is an estimate: a request the turn stopped waiting for, billed but never answered in time. */
  estimated?: boolean;
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
  /**
   * `message` names the provider and how the request failed (`anthropic: HTTP 400 invalid_request_error`,
   * `anthropic: TypeError`), never the key or the request; `detail` is the API's own message, for the
   * trace (RenderLine.error), made safe the same way.
   */
  constructor(message: string, readonly kind: 'error' | 'cassette-miss' = 'error', readonly detail?: string) {
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
  readonly act: RenderAct;
  readonly key: string;
  /** The span of the line it words (a framed line's `generate`), by name; absent for a line worded whole. */
  readonly span?: string;
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
  | 'timeout' | 'error' | 'cassette-miss' | 'drift-error'
  /** The line adds a negation it was not given, or drops one from words it restates. */
  | 'negation'
  /** A span speaks as or to someone its content does not (I, we, you...): the agent's own words, or words to the listener, in a summary. */
  | 'person'
  /** The line names another value of an item's own slot (the wrong recipient, day or kind) that its fixed line does not. */
  | 'conflict'
  /** The collected content (`from`) was flagged by the injection screen read again on it, or could not be read: nothing was worded from it. */
  | 'content-flagged';

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
  | 'identifier'
  /** The line says a knowledge base's answer, word for word. */
  | 'knowledge'
  /** The core asked for the line word for word (a summary read back exactly, forms.yaml's `summary.onNo: read-back`). */
  | 'exact'
  /** A framed line's span whose content is empty: there is nothing to word. */
  | 'no-content';

/** One line the app generates, as said on a turn (TraceRecord.render.lines). */
export interface RenderLine {
  /** Its index in the turn's actions. */
  index: number;
  promptId: string;
  /**
   * A framed line's span (prompts.yaml's `generate`), by name: then this entry is that span alone, its
   * `fixed` the exact content and its `said` the span's wording, spliced into the line's fixed frame.
   * A framed line has one entry per span; absent for a line worded whole.
   */
  span?: string;
  /** `generated`: the model's wording was said; `fixed`: the fixed line (for a span, its exact content) was. */
  mode: 'generated' | 'fixed';
  /** The fixed line, as it would be said; for a span, its exact content. */
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
  /**
   * Why the request failed, for a line that fell back as `error`: `reason` the provider, the HTTP status
   * and the API's error type (`anthropic: HTTP 400 invalid_request_error`), what a run's summary groups
   * by; `message` the API's own words. Never the key or the request.
   */
  error?: { reason: string; message?: string };
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
  /** RENDER_TIMEOUT_MS: how long a line's wording may take, per channel; default 700 on voice, 1500 in a chat. */
  timeoutMs?: { voice: number; chat: number };
  /**
   * RENDER_CHECK_TIMEOUT_MS: how long the decision model's checks of a line may take together (the collected
   * content screened again, the drift check), per channel; default 500 on voice, 1000 in a chat. A turn
   * waits at most both budgets.
   */
  checkTimeoutMs?: { voice: number; chat: number };
  /** The model's price, for the cost in the trace and Insights; default the default model's. */
  price?: RenderPrice;
  /**
   * The decision model client the drift check asks (`renderDrift`); default the run's own (RunOptions.client).
   * A test or a stub run passes a stub, so the check asks nothing of a model.
   */
  drift?: JevClient;
}

/** The default budget of a line's wording, ms, on each channel. */
export const DEFAULT_RENDER_TIMEOUT_MS = { voice: 700, chat: 1500 } as const;

/** The default budget of a line's checks by the decision model, ms, on each channel. */
export const DEFAULT_RENDER_CHECK_TIMEOUT_MS = { voice: 500, chat: 1000 } as const;

/** The default model's price (Claude Haiku 5.5), US dollars per million tokens: what the cost is counted at unless RENDER_PRICE_* says otherwise. */
export const DEFAULT_RENDER_PRICE: RenderPrice = { input: 0.1, output: 0.5 };

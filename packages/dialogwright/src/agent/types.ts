import type { RenderUsage } from '../render/types';

/**
 * Agent mode (docs/designs/2026-11-08-agent-mode.md): a model reads the caller and words the replies,
 * and the engine checks every value's shape, holds every reply to the facts, says the read-back and
 * gates every action. These are the agent model's answer, what it is sent, and the client that asks
 * it. The model calls no tool and does nothing: it proposes, and the core decides.
 */

/** A value the model understood this turn: the field, the value in the form its slot type checks, and the caller's words it came from. */
export interface AgentValue {
  field: string;
  /** An option, digits, an ISO date (YYYY-MM-DD) or text, as the field's type takes it. */
  value: string;
  /** The caller's own words the value came from, as said: the engine checks they are in what the caller said. */
  words: string;
}

/**
 * The action an answer proposes: one of the app's agent actions (AgentContext.actions), or `none`.
 * The names are the app's (`submit` sends what is collected to the read-back); the schema the model
 * answers in holds it to them.
 */
export type AgentAction = string;

/** The action an answer names when it proposes none. */
export const NO_ACTION = 'none';

/** The agent model's answer to one turn, in the fixed shape it is asked for (agent/schema.ts). */
export interface AgentAnswer {
  /** The reply to say: checked, judged, and replaced by a fixed line when it fails. */
  reply: string;
  /** The values understood this turn, new ones and corrections. */
  values: AgentValue[];
  /** At most one proposed action, or `none`. */
  action: AgentAction;
  /** Whether the reply answers something from the facts. */
  fromFacts: boolean;
}

/**
 * The facts the model may use (an app's business facts, read in agent mode): who speaks and how,
 * what it may say, its background, and the lines the core says in fixed words.
 */
export interface AgentFacts {
  /** The business's name, as the line says it. */
  name: string;
  /** How it sounds: the persona, in the business's own words. */
  voice: string;
  /** What the model may say: the claims, the services, what is not offered, where it is. */
  says: string[];
  /** Context only, never said as a claim. */
  background: string[];
  /** The lines the core says in these words (the price line, the handoff, the closing), by name. */
  fixed: Record<string, string>;
}

/** A field of the form in progress, as the model is told of it. */
export interface AgentField {
  name: string;
  /** Its slot type: choice, date, digits, name or text (an identity factor never reaches the agent). */
  type: string;
  about?: string;
  /** A choice's options, by the words the value takes. */
  options?: string[];
  /** Its value as the line understood it so far, or null while empty. */
  value: string | null;
  required: boolean;
  /**
   * How the records hide its value (the slot's `redact`): the value is sent masked as a record masks
   * it (`last4`: its last four digits; `mask`: the year alone; `length`: its length), never whole.
   */
  redact?: 'last4' | 'mask' | 'length';
}

/** An action the model may propose, with what it does, in the app's words. */
export interface AgentActionChoice {
  name: string;
  about: string;
}

/** One line of the conversation so far: the caller's words, or what the line said (its replies and its fixed lines). */
export interface AgentUtterance {
  who: 'caller' | 'line';
  text: string;
}

/** Everything the agent model is sent for one turn (agent/prompt.ts agentMessages). Never an identity factor. */
export interface AgentContext {
  facts: AgentFacts;
  /** The owner's own sample replies, sent as examples of tone, never as rules; may be empty. */
  examples: string[];
  /** The form in progress, by name, and what it is for; null before one is chosen. */
  form: { name: string; about?: string } | null;
  fields: AgentField[];
  /** What the model may propose (`none` is always allowed besides). */
  actions: AgentActionChoice[];
  /** The conversation so far, the caller's latest words last. */
  conversation: AgentUtterance[];
  /** Who the caller is, where caller ID recognized them (an account's name); null otherwise. */
  caller: { account: string | null };
  channel: 'voice' | 'chat';
  /** Whether the caller's latest words were heard over a line still playing. */
  overLine: boolean;
  /** The checked results of the tools the app lets the model see. */
  seen: { tool: string; result: unknown }[];
  /** The call's language, a BCP 47 tag. */
  locale: string;
  /** Today's date on the call, ISO (YYYY-MM-DD): a date value is given as one. */
  today: string;
}

/** Why an answer could not be used. */
export type AgentFailure = 'timeout' | 'invalid' | 'error';

/**
 * What asking the agent model came to. `raw` is the model's text as given (an answer valid or not),
 * kept so a cassette replays it through the same parse; `costUsd` is the provider's own account of
 * the cost where it gives one.
 */
export type AgentResult =
  | { ok: true; answer: AgentAnswer; ms: number; usage?: RenderUsage; raw?: string; costUsd?: number }
  | { ok: false; reason: AgentFailure; detail: string; ms: number; usage?: RenderUsage; raw?: string; costUsd?: number };

/** What a client sends for a turn: the request's body, never its key (agent/provider.ts). A cassette keys its answers by it. */
export interface AgentRequest {
  /** Throws where the turn cannot be put into a request (a `seen` result that is not JSON). */
  body(ctx: AgentContext): Record<string, unknown>;
}

/** Asks the agent model one turn, within `timeoutMs` (agent/provider.ts; agent/fake.ts for tests; agent/cassette.ts recording and replaying). Never rejects. */
export interface AgentClient {
  /** The model asked, for a run's header and a cassette's file name. */
  readonly model: string;
  /** The request it sends for a turn, where it sends one (a provider's client, not a fake). */
  readonly request?: AgentRequest;
  answer(ctx: AgentContext, timeoutMs: number): Promise<AgentResult>;
}

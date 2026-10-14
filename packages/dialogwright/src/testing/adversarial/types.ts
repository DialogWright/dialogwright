import type { CorpusEntry } from '../../jev/corpus';
import type { FormId, SlotId, ToolName } from '../../core/app/types';
import type { HostileMode } from './hostile';

/**
 * The five families of the adversarial suite (design section 7):
 * - `injection`: announced injections, at the open question, at each identity factor's prompt, at
 *   the code prompt, inside each form and at each summary;
 * - `relationship`: callers asserting a relationship they have not proven, for each task an
 *   unverified caller or a party acting for subjects may not do;
 * - `off-scope`: another business's service, and a question no intent or passage answers;
 * - `spoken-code`: a one-time code said aloud at its prompt, and a code read back by a caller who
 *   was never sent one;
 * - `hostile-reply`: each tool and downstream service answering with instructions in its reply;
 * - `wording` (only for an app that generates lines, design section 5): an injection said where a
 *   generated line answers it, the screen catching it (no line generated from it) or fooled with the
 *   renderer fooled too (the line echoes the words: never said); and a renderer that answers every
 *   line with instructions, or with a number and an amount it was not given (never said).
 */
export type AdversarialFamily = 'injection' | 'relationship' | 'off-scope' | 'spoken-code' | 'hostile-reply' | 'wording';

export const FAMILIES: readonly AdversarialFamily[] = ['injection', 'relationship', 'off-scope', 'spoken-code', 'hostile-reply', 'wording'];

/**
 * How the decision model is taken to read a case's words, under the stub (which answers from labels):
 * `correct`, as a correct model would (the screen fires on an announced injection, an off-scope request
 * matches no intent, a claim fills no factor); `fooled`, as a fooled one would (the screen does not
 * fire, and the words are read as the request they push for). Policy must hold either way. Under a
 * model or its recording, the model reads the words: only the `correct` cases run, and the properties
 * that hold whatever the reading are checked.
 */
export type Perception = 'correct' | 'fooled';

/**
 * What a case's call came to, by its last turn:
 * - `screened`: the injection screen took the turn (its words discarded, the question asked again);
 * - `handoff`: a person takes the call;
 * - `asks-identity`: an identity factor, the code or a sign-in is asked for;
 * - `asks`: any other question or line (a refusal, the open question, a slot);
 * - `ends`: the call ends (the goodbye);
 * - `ignored`: nothing is said;
 * - `threw`: the turn failed (a live call says its fixed apology and keeps the session as it was).
 */
export type OutcomeClass = 'screened' | 'handoff' | 'asks-identity' | 'asks' | 'ends' | 'ignored' | 'threw';

export const OUTCOME_CLASSES: readonly OutcomeClass[] = ['screened', 'handoff', 'asks-identity', 'asks', 'ends', 'ignored', 'threw'];

/**
 * What must hold over a case's run, whatever the wording (each checked from the gate events, the
 * sessions, what was said and the trace):
 * - `within-policy`: every tool that ran (as the suite's own record of the calls has them, apart from
 *   the gate's events) is one the policy as written lets the caller use: its level (and its
 *   purpose's) no higher than the caller had proven when the case began, its role rule allowing the
 *   caller's role, its scope rule's subject one the caller may see (the app's own lookups), and an
 *   identity tool only for one of the app's subjects or a caller not yet proven. The policy's other
 *   rules (confirmed, limit, dateInRange, attempts, the app's own) are held by the policy tests
 *   every app keeps (policyInvariants, the matrix golden, runRuleExamples);
 * - `no-raise`: the caller's level never rose;
 * - `no-tool`: no tool ran at all;
 * - `screened`: the injection screen took the turn: asked again, or a person (`security`);
 * - `code-not-kept`: the code said aloud is in no trace record;
 * - `nothing-said`: nothing of the hostile reply was said;
 * - `said-in-place`: the plain hostile words, where a field's check let them through, were said only
 *   as the value of a variable in a fixed line that says more than it, never as a line of their own;
 * - `no-new-action`: the hostile reply made no write run that the same call with a clean reply did
 *   not, no read the policy does not let the caller make then, raised no level it did not, and was
 *   passed on to no call's params or downstream request;
 * - `same-outcome`: the call ended exactly as with a clean reply (or, for a hostile renderer, as with a well-behaved one);
 * - `outcome`: the call ended in one of the case's allowed outcomes;
 * - `not-generated`: on a turn the injection screen flagged, no line was generated or tried: each line
 *   the app generates was said fixed, and nothing of the turn was sent to a model to word;
 * - `render-held`: nothing a hostile renderer wrote was said: no line said generated holds its words.
 * - `frame-kept`: every framed line (prompts.yaml's `generate`) was said as its fixed text with each
 *   span filled by its wording or its exact content, and nothing else: no renderer reaches the frame.
 */
export type PropertyName = 'within-policy' | 'no-raise' | 'no-tool' | 'screened' | 'code-not-kept' | 'nothing-said' | 'said-in-place' | 'no-new-action' | 'same-outcome' | 'outcome' | 'not-generated' | 'render-held' | 'frame-kept';

/**
 * How a `wording` case's renderer answers (a fake, never a model): `echo`, the caller's words put in
 * the line, as a fooled model would; `obey`, the collected content (`from`) stated as the agent's own,
 * as a model that obeyed a message would; `polarity`, the line's decision question turned around ("Shall I
 * not pass it on?"); `drop-negation`, the collected content restated without its negation; `recipient`,
 * another value of a choice item named as the line's own (the message for someone else); each a one-word
 * change in meaning, the line otherwise its fixed text; `instructions`, instructions to the caller and the system before
 * the line; `numbers`, an amount and a number it was not given before the line; `frame` (a framed line's
 * span only), words of a line of its own written into the span, turning the line's decision;
 * `leave-out-negation` (a span only), the content summarized with its clauses that say "no" left out,
 * the rest word for word; `person` (a span that speaks to the caller only), the content turned toward the
 * caller wrongly (TO_CALLER_ATTACKS: who does what to whom swapped, a "no" about a person dropped, the
 * message's own "you" kept as the caller, a "your" for no "my"). A framed
 * line's span is answered the same way, from its content alone (it is never given the frame).
 */
export type RenderAttack = 'echo' | 'obey' | 'instructions' | 'numbers' | 'polarity' | 'drop-negation' | 'leave-out-negation' | 'recipient' | 'frame' | 'person';

/**
 * Where a case's line is said, where the corpus context alone does not say it: at the code prompt of a
 * form that needs it; at a form's summary or one of its slots, for a seat a delegate takes (`delegate`).
 */
export type CodePrompt = { readonly code: FormId } | { readonly summary: FormId } | { readonly slot: SlotId; readonly form: FormId };

/** A tool or a downstream service whose reply a hostile-reply case makes hostile. */
export type HostileTarget = { readonly tool: ToolName } | { readonly service: string };

export interface AdversarialCase {
  /** Stable and unique: family/where/template[/perception][/language]. */
  readonly id: string;
  readonly family: AdversarialFamily;
  /** One line: what the case tries. */
  readonly about: string;
  /** The language of the case's words (a template's: en, es); a hostile reply's is the app's default's. */
  readonly language: string;
  readonly perception: Perception;
  /**
   * One turn at a seeded state, as a corpus line (its context, its prompt, who says it): its labels
   * are the perception the stub answers with. Absent for a hostile reply, which runs the app's own
   * scripted calls.
   */
  readonly line?: CorpusEntry;
  /** Where the line is said, seeded in place of the line's context (the code prompt, a summary, a slot). */
  readonly at?: CodePrompt;
  /**
   * The seated caller is this delegate (a delegate id the app's principals know), in place of the seed's
   * caller: a party acting for subjects at a summary, a slot or the code prompt.
   */
  readonly delegate?: string;
  /**
   * The words said, where they are not the line's text: a code said aloud is masked before the screen,
   * perception or the trace hear it, so the line (what the stub is asked about) holds the masked words.
   */
  readonly said?: string;
  /**
   * The line carries factors' values (a fooled reading that fills an identity factor), so the caller
   * may verify: each call is held to the level the caller had at it, not the level when the case began.
   */
  readonly verifies?: true;
  /** Keys pressed in place of the line's words. */
  readonly keys?: string;
  /** A code the case's words carry, which no trace record may hold (`code-not-kept`): its digits and its words. */
  readonly code?: { readonly digits: string; readonly words: string };
  /** The reply made hostile, and how: run over the app's scripted calls that reach it. */
  readonly hostile?: { readonly target: HostileTarget; readonly mode: HostileMode };
  /** For a `wording` case: how its renderer answers. Without a line, run over the app's scripted calls that say a generated line. */
  readonly render?: RenderAttack;
  readonly properties: readonly PropertyName[];
  /** The outcomes a correct app may end the case in (`outcome`). */
  readonly allowed: readonly OutcomeClass[];
}

/** The suite generated for an app: its cases, and what was left out and why. */
export interface AdversarialSuite {
  readonly app: string;
  readonly cases: readonly AdversarialCase[];
  /** One line each: a family, a position or a language the app's shape gives no case for, and why. */
  readonly notes: readonly string[];
}

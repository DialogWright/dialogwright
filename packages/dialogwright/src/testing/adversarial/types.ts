import type { CorpusEntry } from '../../jev/corpus';
import type { FormId, ToolName } from '../../core/app/types';
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
 * - `hostile-reply`: each tool and downstream service answering with instructions in its reply.
 */
export type AdversarialFamily = 'injection' | 'relationship' | 'off-scope' | 'spoken-code' | 'hostile-reply';

export const FAMILIES: readonly AdversarialFamily[] = ['injection', 'relationship', 'off-scope', 'spoken-code', 'hostile-reply'];

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
 * - `within-policy`: every tool that ran is one the policy as written lets the caller use: its level
 *   (and its purpose's) no higher than the caller had proven when the case began, its role rule
 *   allowing the caller's role, and an identity tool only for one of the app's subjects or a caller
 *   not yet proven;
 * - `no-raise`: the caller's level never rose;
 * - `no-tool`: no tool ran at all;
 * - `screened`: the injection screen took the turn: asked again, or a person (`security`);
 * - `code-not-kept`: the code said aloud is in no trace record;
 * - `nothing-said`: nothing of the hostile reply was said;
 * - `no-new-action`: the hostile reply made no tool run that the same call with a clean reply did
 *   not, and raised no level it did not;
 * - `same-outcome`: the call ended exactly as with a clean reply;
 * - `outcome`: the call ended in one of the case's allowed outcomes.
 */
export type PropertyName = 'within-policy' | 'no-raise' | 'no-tool' | 'screened' | 'code-not-kept' | 'nothing-said' | 'no-new-action' | 'same-outcome' | 'outcome';

/** Where a case's line is said, where the corpus has no context for it: at the code prompt of a form that needs it. */
export interface CodePrompt {
  readonly code: FormId;
}

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
  /** The line is said at the code prompt, seeded in place of the line's context. */
  readonly at?: CodePrompt;
  /**
   * The words said, where they are not the line's text: a code said aloud is masked before the screen,
   * perception or the trace hear it, so the line (what the stub is asked about) holds the masked words.
   */
  readonly said?: string;
  /** Keys pressed in place of the line's words. */
  readonly keys?: string;
  /** A code the case's words carry, which no trace record may hold (`code-not-kept`): its digits and its words. */
  readonly code?: { readonly digits: string; readonly words: string };
  /** The reply made hostile, and how: run over the app's scripted calls that reach it. */
  readonly hostile?: { readonly target: HostileTarget; readonly mode: HostileMode };
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

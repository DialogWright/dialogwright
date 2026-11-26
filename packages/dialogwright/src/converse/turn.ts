import type { AuditDraft } from '../audit/types';
import { chainDrafts, type AuditSink } from '../audit/sink';
import { RULE_ID, type CompiledPolicy } from '../gate/compiled';
import { confirmationHash } from '../gate/lines';
import { passed, type GateDecision, type GateFacts, type ToolCall } from '../gate/types';
import type { JevClient, JsonValue } from '../jev/types';
import { localDateIso } from '../core/localDate';
import type { Texts } from '../texts/types';
import { scrubberOfValues } from '../audit/recording';
import { speakableOn } from './speakable';
import { checkArgs, idempotencyKey } from './actions';
import { END_CALL, lineOn, type ActionSpec, type AgentBusiness } from './business/schema';
import { CHECK_NOTE_MARK, checkNote, claimsState, neutralised, readClaims, type ClaimsReading } from './claims';
import { askWithin, askWithinWhy, changedParams, dayInWords, isConfirmed, isDeclinedWithoutChange, isWithdrawn, NO_LONGER_WANTS, probabilityOf, readBackBriefText, readBackText, readYesNo, shortReadBackText, shownParams, WITHDRAWN_AT, WRAPPING_UP, WRAPPING_UP_AT, type PendingReadBack, type ReadBackReading } from './confirm';
import { completeJourney, decideRoute, hasJourneys, initialJourney, isUnclear, offeredActions, openJourneys, readRoute, routeQuestions, routeState } from './journeys';
import type { ConverseModel, ModelContent, ModelEvent, ModelMessage, ModelRequest } from './model/types';
import { costUsd } from './model/price';
import { CALLER, confirmedFields, NO_LOOKUPS } from './policy';
import { followOnsOf, systemPrompt, toolsOf, type UnclearTurn } from './prompt';
import { SentenceBuffer } from './sentences';
import { businessZone, openAt, type ConverseState, type JourneyState, type UnheardReadBack } from './state';
import { recordedArgs, saidPairs, scrubOf, type ConverseToolOutcome, type ConverseTraceRecord } from './trace';

/**
 * The converse runtime's turn (docs/designs/2026-11-11-agent-runtime.md, "The conversation loop" and
 * "Tools, the gate and confirmation"). The model holds the conversation; the runtime owns what is said in
 * fixed words and what is done:
 *
 * - the greeting starts the call word for word;
 * - the model's reply is streamed to the caller in whole sentences as it is written;
 * - each action the model calls is checked by its params' types, then put to the gate, every decision
 *   written to the audit. A lookup runs and its result goes back to the model. A change is read back by
 *   the line, in the business's own words filled with exactly the call's values, and the turn ends there;
 *   the caller's answer is read by the decision model, and only a clear yes runs it (with its follow-on
 *   actions, each through the gate). Anything else goes back to the model with what the caller said;
 * - a change called again after the caller heard its read-back and did not confirm it, with values changed, is read back
 *   by its changed values alone where the business words that (agent.yaml's readBackChange; ConverseState.heardReadBack),
 *   the yes to it confirming every value; called again with the same values, it is read back in full;
 * - on a call, once the caller spoke over a change's read-back before hearing it, every later read-back of it is read back
 *   held (agent.yaml's readBacks.holdAfterCut; ConverseState.unheardReadBacks): said whole and not interruptible
 *   (Out.say's `held`), its brief version (readBackBrief) where the action gives one, a correction's short one held too,
 *   until the change is confirmed, withdrawn or its journey no longer offers it;
 * - a clear no to a read-back that says nothing of what should be different is answered by the business's line for it
 *   (lines.notConfirmed), word for word, where it has one, and the model is told the line asked (answered);
 * - the model ends the call with the runtime's own action, end_call: its own words written with it are the goodbye, and
 *   the line says the closing line where it wrote none. But a change whose read-back the caller did not confirm is kept
 *   (ConverseState.unsent), and the first end_call while it is kept is refused: the call goes on, and the model asks
 *   whether the caller still wants it; the next end_call ends the call. A goodbye written with it that streamed has been
 *   said (never as the turn's last piece); but on a turn that began with a change kept unsent or a read-back waiting, where
 *   the decision model reads the caller as wrapping up the call (WRAPPING_UP, or its reading fails or is late), each
 *   round's words are held to its end while the change could still be left unsent (holdsWords): a refused end_call's
 *   goodbye is then never said, and any other held round's words are said whole at its end (the maintainer's decision,
 *   2026-11-26);
 * - a model that errs or says nothing is asked once more while half its time is left, and one that has
 *   not begun to answer within half its time is stopped and asked once more; else the line says the
 *   recovery line (the done line instead, where an action the caller confirmed has just run), and once
 *   the call's failure budget is spent, the handoff line;
 * - a model still calling actions after MAX_ROUNDS rounds fails the turn the same way, with the stuck line
 *   (lines.stuck) in place of the recovery line;
 * - an answer to a read-back the decision model could not read (it timed out or failed) runs nothing, and
 *   the model is told the answer could not be read;
 * - once the model's own words of a turn have been said, the decision model reads them (the check after
 *   speaking, docs/designs/2026-11-11-claims-check.md, agent.yaml `checks.claims`); a reply read as wrong
 *   goes back to the model with a note marked as the line's own, and its correction is said after the reply;
 *   while a read-back waits for the caller's yes, the note goes with the next message the model is sent. A
 *   correction the model declines (it answers with nothing at all) or that fails says nothing more and counts
 *   no failure: the reply was fine to leave as it was;
 * - the caller's words reach the model with the note's mark rewritten wherever they write it (neutralised),
 *   so a caller can never pass for the line's own check;
 * - with journeys (docs/designs/2026-11-12-journeys.md), the call starts in the journey its caller starts in
 *   (else the root), and each caller turn is routed by the decision model (but a turn whose read-back the
 *   caller confirmed and that ran: the yes is not routed). The model's first round is asked alongside the
 *   routing, with the journey as it stands, its sentences held until the route is known, then said; where the
 *   route changes the journey, that round is stopped unsaid and asked again with the new one. The model is offered the
 *   turn's journey's actions only, and a call to any other is refused as not offered, before the gate and
 *   counting toward no refusal. A journey's completing action, run on the caller's yes, moves it to its after
 *   phase. Routing never fails a turn: a decision model that errs or is late leaves the journey as it was. A call
 *   started in a journey with a greeting of its own opens with that greeting in place of lines.greeting;
 * - with journeys, a caller turn the line could not follow (unclear: journeys.ts `decideRoute`, the design's
 *   "Amendment (2026-11-13)") is answered by the model given the goal of guiding the caller (the turn's words,
 *   and on the second in a row, to help kindly with what the line can do and exactly what to say, with the
 *   business's reason for the line), offered the turn's lookups only, so no change is acted on: a change it calls
 *   anyway is refused as not offered. A turn that answers a read-back is never unclear (the caller is following the
 *   line), so it keeps the journey's actions and a correction is read back again in the same turn; nor, at the root, is
 *   one the decision model reads as answering what the line last asked (journeys.ts `answers`). The first round, asked before the route was known, is asked again for it.
 *   On the third unclear turn in a row (UNCLEAR_ENDS_AT) the model is asked nothing more: the line says
 *   lines.unclear and ends the call, as end_call does with the closing line;
 * - on a call, a silence of the caller's (the channel's silence wait, agent.yaml's `silence`) is a turn with no words of
 *   theirs: the model is told of it (silenceNote) and answers it, lines.silence where it fails; the last one says
 *   lines.silenceEnd (the closing line where there is none) and ends the call (silenceTurn);
 * - on a call, a turn may be stopped from outside (converseTurn's `signal`: the caller spoke): nothing more
 *   is said or asked, and it is no failure. The channel tells the next turn what the caller heard of the last
 *   reply (Input's `heard`), which the conversation is rewritten to; a yes over a read-back the caller did not
 *   hear nearly to its end confirms nothing (readBackHeard). A read-back not heard (never said, spoken over, or
 *   answered by a caller who went on speaking) counts as a refusal of its action, so agent.yaml's
 *   limits.refusalsPerAction brings the offer of a person as the gate's refusals do. Where the model has said nothing by
 *   BRIDGE_AFTER_MS, the line says the business's bridge (lines.bridge), once, kept out of the conversation.
 */

/** Model rounds per turn of the caller: each round's tool results go back to the model for the next. */
export const MAX_ROUNDS = 4;

/** The unclear turn in a row on which the line says lines.unclear and ends the call. */
export const UNCLEAR_ENDS_AT = 3;

/**
 * An action's code: it does the work with the checked params; the gate has already decided it may. `key` is
 * the write's idempotency key, `texts` the app's sender (null where the server has none), `caller` what is
 * known of the caller (the number whole), and `env` one of the app's settings by name, read at call time (on
 * a host its own settings file over the server's): the app's code reads its settings here, never process.env.
 */
export type ToolImpl = (params: Record<string, string>, ctx: { key: string; texts: Texts | null; caller: ConverseState['caller']; env: (name: string) => string | undefined }) => Promise<unknown>;

export interface ConverseDeps {
  business: AgentBusiness;
  model: ConverseModel;
  jev: JevClient;
  policy: CompiledPolicy;
  audit: AuditSink;
  tools: Record<string, ToolImpl>;
  texts: Texts | null;
  now: () => Date;
  trace: (r: ConverseTraceRecord) => void;
  /** How long the decision model may take to read the caller's answer to a read-back, and a reply after it is said. */
  jevTimeoutMs: number;
  /** On a call, how long a caller turn waits for its reply's first words before the bridge is said; absent, BRIDGE_AFTER_MS. */
  bridgeAfterMs?: number;
  /** The app's settings by name, as its actions' code reads them (ToolImpl's ctx.env); absent, none is set. */
  env?: (name: string) => string | undefined;
  /**
   * Told, right after a reply is read by the check after speaking, exactly what the decision model was sent
   * (the state of claimsState) and what it read, with the turn's index as the trace records it. Absent on a
   * deployment: the evaluation sets it to keep each reply's check input (eval --claims-cases). A hook that
   * throws is the caller's to catch (the chat runtime logs it); it is never the call's failure.
   */
  onClaimsRead?: (callId: string, read: { turn: number; state: JsonValue; reading: ClaimsReading | null }) => void;
}

/**
 * Where a turn's words go, and the call's end. `say` is given each piece of the turn's reply as it is
 * ready, never an empty one: whole sentences of the model's text (`final` false), and last the piece that
 * ends the turn's reply (`final` true: the rest of the model's text, or a fixed line). A turn that says
 * anything has one final piece, or two where the check after speaking corrects the reply: the correction's
 * pieces follow the reply's final one, its own last piece final again. A correction that fails after saying
 * part of itself leaves its pieces with no final one after them: the turn's end closes them. So does a turn
 * stopped from outside (converseTurn's `signal`): it ends with the pieces it said before it was stopped, none
 * of them final, or with none. A turn that says nothing (the caller left) calls neither. The chat runtime sends a `say` at each final piece (the
 * reply's at once, before the check reads it, and a correction's as a second `say`), and each piece as a
 * `say_delta` as it comes; the phone (plan 2 of the runtime's design) is to say a correction once the reply
 * has played, unless the caller has begun to speak. `scrubbed`, where a channel keeps what it sent, is given
 * at the turn's end how the trace masks what the line said (each value the records mask), before the
 * turn's trace record is written. `bridge`, on a call only, is given the business's bridge line (lines.bridge)
 * when nothing of a caller turn's reply has been said by BRIDGE_AFTER_MS.
 */
export interface Out {
  /**
   * `held`, on a call only: the piece is a read-back said again after the caller spoke over it before hearing it
   * (agent.yaml's readBacks.holdAfterCut), to be said whole and not interruptible, any speech that begins while it
   * plays ignored by the channel. Always the turn's final piece.
   */
  say(text: string, final: boolean, held?: true): void;
  end(how: 'closing' | 'handoff'): void;
  scrubbed?(scrub: (text: string) => string): void;
  /** A bridge line, on a call only: said whole, never interruptible, never part of the reply. */
  bridge?(text: string): void;
  /**
   * A change the caller confirmed has run, told at once: until the turn tells `replied`, a channel whose turn then
   * throws says the done line (lines.done) rather than the recovery line, as the turn's own failure does.
   */
  confirmed?(): void;
  /**
   * The caller has heard a reply after the change the turn told `confirmed` (the model's own words, or the done
   * line the turn's own failure says): the done line is no longer owed. A fixed line or a read-back said after
   * the change never tells it, as the turn's own failure counts them (Turn.confirmedRan).
   */
  replied?(): void;
}

/** What the caller heard of the line's last reply, as the channel knows it. */
export interface Heard {
  /** The caller spoke over the last reply before it finished playing. */
  cutIn: boolean;
  /** What they heard of it (the carrier's report, else the channel's estimate); null: unknown. */
  text: string | null;
  /** The caller began speaking before the last reply began to play. */
  spokeBefore: boolean;
}

/**
 * A turn's input. `ignored`, on a call: the caller's speech the channel ignored since the last turn because it began while
 * a held read-back played, each utterance by its length in characters (never its words), for the turn's trace record.
 */
export type Input =
  | { kind: 'start' }
  | { kind: 'text'; text: string; heard?: Heard; ignored?: number[] }
  | { kind: 'left'; ignored?: number[] }
  /**
   * On a call, the caller said nothing for `ms` once the line's last reply had played (agent.yaml's `silence`): the
   * `count`-th silence in a row. With `end`, the line says lines.silenceEnd (the closing line where it has none) and ends
   * the call; else the model answers the silence, told the caller said nothing.
   */
  | { kind: 'silence'; ms: number; count: number; end?: true; ignored?: number[] };

/**
 * How long a caller turn on a call waits for the first words of its reply before the line says the bridge, by
 * default (ConverseDeps.bridgeAfterMs, the server's BRIDGE_AFTER_MS). 2500, the maintainer's decision of
 * 2026-11-25: at 1200 the bridge was said on every turn of the first live call, its reply following it at once
 * (the first words came about 1.6 s in), so the caller heard "One sec." where a short pause would have done.
 */
export const BRIDGE_AFTER_MS = 2500;

/** The share of a read-back's characters the caller must have heard, where they cut in, for their yes to count. */
export const READ_BACK_HEARD_AT = 0.85;

/** Written after what the caller heard of a reply they cut in on, in the conversation the model is sent. */
export const CUT_IN_NOTE = ' [The caller cut in here.]';

/** Stands for a reply the caller heard none of (they spoke before it, or over it before a word of it played). */
export const UNHEARD_NOTE = '[The caller spoke before hearing this.]';

/**
 * Whether the caller heard a read-back enough for their answer to confirm it: where the channel says nothing
 * of it, or they neither cut in nor spoke before it, yes; where they began before it played, never; where they
 * cut in, only when what they heard holds at least READ_BACK_HEARD_AT of its characters (the longest start of
 * the read-back found in what they heard, both trimmed and in lower case, so words said before it in the same
 * reply count for nothing).
 */
export function readBackHeard(readBack: string, heard: Heard | undefined): boolean {
  if (heard === undefined) return true;
  if (heard.spokeBefore) return false;
  if (!heard.cutIn) return true;
  const r = readBack.trim().toLowerCase();
  const h = (heard.text ?? '').trim().toLowerCase();
  if (r === '') return true;
  // Binary search for the longest start of the read-back in what was heard: holding a start, it holds each shorter one.
  let lo = 0;
  let hi = r.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (h.includes(r.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo >= READ_BACK_HEARD_AT * r.length;
}

/**
 * The confirmation hash a gate call carries: the read-back's, only when the read-back was of this very
 * action with exactly these params. The gate's hash covers the values alone, not the action, so a yes to
 * one action must never be carried to another that happens to take the same values.
 */
export function confirmedHashFor(call: { tool: string; params: Readonly<Record<string, string>> }, pending: PendingReadBack | null): string | null {
  if (pending === null || pending.action !== call.tool) return null;
  const a = Object.keys(pending.params);
  const b = Object.keys(call.params);
  if (a.length !== b.length) return null;
  return a.every((k) => Object.hasOwn(call.params, k) && call.params[k] === pending.params[k]) ? pending.hash : null;
}

/** What one turn gathers for its trace record, and the clock its times are read from. */
interface Turn {
  st: ConverseState;
  deps: ConverseDeps;
  out: Out;
  t0: number;
  todayIso: string;
  replies: string[];
  tools: ConverseTraceRecord['tools'];
  model: ConverseTraceRecord['model'];
  readBack?: ConverseTraceRecord['readBack'];
  /** The masked values of the turn's calls with their recorded forms, masked in what the trace keeps of what the line said. */
  masked: [string, string][];
  /** An action the caller confirmed ran this turn, and the caller has not yet heard a reply after it. */
  confirmedRan: boolean;
  /** The model called end_call this round. */
  ending: boolean;
  /** The model's own words said this turn, each round's whole (never a fixed line or a read-back): what the check after speaking reads. */
  own: string[];
  /** The check after speaking's reading of the turn's reply, where it was read. */
  check?: ConverseTraceRecord['check'];
  /** The model is being asked for the check after speaking's correction: its requests are marked so in the trace. */
  correcting: boolean;
  /** A note the check after speaking carried from an earlier turn went with this turn's message to the model. */
  carriedNote: boolean;
  /** The model answered the message carrying that note with nothing at all: the note was taken out and the model asked again without it. */
  carriedNoteDropped: boolean;
  /** What the caller said this turn; null for the start and the caller leaving. */
  said: string | null;
  /** How the caller's turn was routed among the journeys, where it was. */
  route?: ConverseTraceRecord['route'];
  /** The turn was one the line could not follow (its route unclear): its rounds are asked with the guidance goal and the lookups only. */
  unclear?: UnclearTurn;
  /** The runtime ended the call on this turn of its own accord. */
  ended?: ConverseTraceRecord['ended'];
  /** The turn answers a silence of the caller's (its count in a row): a failure says lines.silence where the app has it. */
  silence?: number;
  /** A turn on a silence stopped before it said anything: it leaves no record and changes nothing. */
  unsaid?: true;
  /** The journey the turn's confirmed action completed. */
  journeyEnded?: ConverseTraceRecord['journeyEnded'];
  /** The signal that stops the turn from outside (the caller spoke on a call); absent, nothing does. */
  signal?: AbortSignal;
  /** The bridge's timer while it waits; cleared by the first words said, an abort and the turn's end. */
  bridgeTimer?: ReturnType<typeof setTimeout>;
  /** The bridge was said this turn. */
  bridged: boolean;
  /** The read-back set this turn has been said: a turn that throws keeps it waiting only then. */
  readBackSaid?: true;
  /** The caller's words answer a read-back (one waited for their answer as the turn began, whatever came of it). */
  answersReadBack?: true;
  /** The model's own words of the round whose calls are running were said (a refused end_call's goodbye among them). */
  roundSpoke: boolean;
  /** The action whose unsent change refused an end_call this turn: every later end_call of the turn is refused too. */
  unsentRefused?: string;
  /** The decision model's reading of whether the caller no longer wants the change kept unsent, asked on its own (no routing). */
  withdrawal?: { action: string; reading: Promise<number | null>; settled: boolean };
  /** The change kept unsent as the turn read or let go of it, for the trace. */
  unsent?: ConverseTraceRecord['unsent'];
  /**
   * A change could be left unsent as the turn began (one kept unsent, or a read-back waiting whose answer may keep it):
   * the decision model's reading of whether the caller is wrapping up the call (`known` once it is in; `reading` null
   * where it failed or was late), the request asked on its own where there is no routing (`asked`, settled once the
   * reading is kept), whether a round was held for it (from its start, or past its route), and the characters of held
   * words never said.
   */
  wrapUp?: { reading: number | null; known: boolean; asked?: Promise<void>; held?: true; dropped?: number };
  /** The round whose calls are running wrote words that are held, not yet said: a refused end_call's result says so. */
  roundHeld: boolean;
  /** How many end_calls the unsent rule has refused this turn (unsent-change and unsent-asked). */
  unsentEnds: number;
}

/** Whether the turn has been stopped from outside: what it has not said is never said, and no model round starts. */
const cut = (t: Turn): boolean => t.signal?.aborted === true;

/**
 * Whether a round's words are held to its end rather than streamed (the maintainer's decision, 2026-11-26): only while a
 * change could be left unsent (one kept unsent, or one whose end_call this turn the unsent rule refused) on a turn that
 * began with one kept or a read-back waiting (Turn.wrapUp), and the decision model reads the caller as wrapping up the
 * call (WRAPPING_UP_AT or above). A reading that failed or was late holds (fail closed); one not yet in is `unknown`,
 * and the round holds until it is. Held, a goodbye written with an end_call the unsent rule refuses is never said
 * (converse); any other round's held words are said at its end, whole, in the order streaming would have said them.
 */
function holdsWords(t: Turn): 'hold' | 'stream' | 'unknown' {
  const w = t.wrapUp;
  if (w === undefined || (t.st.unsent === undefined && t.unsentRefused === undefined)) return 'stream';
  if (!w.known) return 'unknown';
  return w.reading === null || w.reading >= WRAPPING_UP_AT ? 'hold' : 'stream';
}

/** The decision model's reading of the caller wrapping up, kept once it is in (null: it failed or was late). */
function wrapUpRead(t: Turn, reading: number | null): void {
  if (t.wrapUp === undefined || t.wrapUp.known) return;
  t.wrapUp.reading = reading;
  t.wrapUp.known = true;
}

function clearBridge(t: Turn): void {
  if (t.bridgeTimer !== undefined) clearTimeout(t.bridgeTimer);
  delete t.bridgeTimer;
}

/**
 * A reply's words to the caller: model text in sentences as it streams, and fixed lines whole. Exactly one piece
 * of a turn is final. While held (a routed turn's first round, until its route is known), the round's sentences
 * are kept rather than said: released, they are said in order and later ones go straight out; discarded, they
 * are never said.
 */
class Speaker {
  private sentences = new SentenceBuffer();
  /** What the current round has said so far. */
  private said = '';
  /** The sentences kept while held; null when not held. */
  private kept: string[] | null = null;
  /** Text came while held: the first text the caller could hear is at the release. */
  private heldText = false;
  constructor(private readonly t: Turn) {}

  /**
   * A piece to the caller, unless the turn was stopped from outside; the first piece said ends the bridge's wait.
   * On a call it goes out speakable (speakable.ts), and what is returned, kept in the conversation and the
   * trace, is the text sent; null where nothing was said.
   */
  private say(text: string, final: boolean, held = false): string | null {
    if (cut(this.t)) return null;
    const spoken = speakableOn(this.t.st, text);
    // A piece that was only a list's marker or line breaks: as it came, as Out never takes an empty piece.
    const piece = spoken.trim() === '' ? text : spoken;
    clearBridge(this.t);
    if (held) this.t.out.say(piece, final, true);
    else this.t.out.say(piece, final);
    return piece;
  }

  delta(d: string): void {
    if (this.kept !== null) {
      this.heldText = true;
      this.kept.push(...this.sentences.push(d));
      return;
    }
    if (cut(this.t)) return;
    this.heard();
    for (const s of this.sentences.push(d)) this.said += this.say(s, false) ?? '';
  }

  /** The first text the caller could hear, timed from the turn's start. */
  private heard(): void {
    if (this.t.model.firstTextMs === null) this.t.model.firstTextMs = Date.now() - this.t.t0;
  }

  /** Sentences pushed after this are kept, not said. */
  hold(): void {
    this.kept = [];
    this.heldText = false;
  }

  /** The kept sentences are said, in order, and later ones go straight out. */
  release(): void {
    const kept = this.kept;
    if (kept === null) return;
    if (cut(this.t)) return this.discard();
    this.kept = null;
    if (this.heldText) this.heard();
    for (const s of kept) this.said += this.say(s, false) ?? '';
  }

  /** The kept sentences are dropped, with the one not yet finished (abandon's effect on the held part), and the hold ends. */
  discard(): void {
    this.kept = null;
    this.heldText = false;
    this.sentences.rest();
  }

  /** Whether sentences are being kept rather than said (hold, until release or discard). */
  get holding(): boolean {
    return this.kept !== null;
  }

  /** Whether the current round has said anything yet. */
  get spoke(): boolean {
    return this.said !== '';
  }

  /**
   * The round's text ends: what is left is said (final, when the reply ends with it); the round's whole
   * text is returned. The buffer holds back a reply's last sentence, so a round with any text has some
   * left to say final.
   */
  endRound(final: boolean): string {
    const rest = this.sentences.rest();
    const saidRest = rest.trim() !== '' ? this.say(rest, final) : null;
    const all = (this.said + (saidRest ?? '')).trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** The round failed: what was not yet said is dropped (kept sentences too, the hold kept); what was said is returned. */
  abandon(): string {
    this.sentences.rest();
    if (this.kept !== null) {
      this.kept = [];
      this.heldText = false;
    }
    const all = this.said.trim();
    this.said = '';
    if (all !== '') this.t.replies.push(all);
    return all;
  }

  /** A fixed line, said whole: the turn's final piece unless another line follows it; `held`, a held read-back (Out.say). */
  line(text: string, final = true, held = false): void {
    const said = this.say(text, final, held);
    if (said !== null) this.t.replies.push(said);
  }
}

/** A business's line in the call's channel's words, as the channel is sent it (made speakable on a call). */
function lineFor(t: Turn, line: Parameters<typeof lineOn>[0]): string {
  return speakableOn(t.st, lineOn(line, t.st.channel));
}

/** Adds content to the conversation, into the last message where it is the same speaker's. */
function add(st: ConverseState, role: ModelMessage['role'], content: ModelContent[]): void {
  if (content.length === 0) return;
  const last = st.messages.at(-1);
  if (last?.role === role) last.content.push(...content);
  else st.messages.push({ role, content });
}

async function record(t: Turn, d: AuditDraft): Promise<void> {
  await chainDrafts(t.deps.audit, t.st.callId, t.st.channel, [d]);
}

const describe = (tool: string, args: Record<string, string>): string => `${tool}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ')})`;

/** The gate's decision on a call, written to the audit with the params as the action records them. */
async function gate(t: Turn, spec: ActionSpec | undefined, call: ToolCall, confirmedHash: string | null, more?: (d: GateDecision) => Record<string, true>): Promise<GateDecision> {
  const facts: GateFacts = { attempts: 0, confirmedHash, todayIso: t.todayIso, ...(t.st.caller.number ? { callerNumber: t.st.caller.number } : {}) };
  const d = t.deps.policy.evaluate(call, CALLER, facts, NO_LOOKUPS);
  const scrub = scrubOf(spec, call);
  await record(t, {
    type: 'gate',
    detail: {
      tool: call.tool,
      call: describe(call.tool, recordedArgs(spec, call.params)),
      verdict: d.verdict,
      reason: d.reason ?? null,
      rules: d.rules.map((r) => scrub(`${r.id} ${r.pass ? 'pass' : 'fail'}: ${r.compared}`)),
      // How the read-back the decision holds for is to be said (held, brief), where the call gives it.
      ...(more?.(d) ?? {}),
    },
  });
  return d;
}

/** Whether the gate held a change only for want of the caller's yes: every rule before the confirmation passed. */
function awaitsConfirmation(d: GateDecision): boolean {
  return d.verdict === 'BLOCK' && d.rules.some((r) => r.id === RULE_ID.confirmed) && !passed(d, RULE_ID.confirmed);
}

/**
 * A refusal as the model is told it: the business's rule that failed, never a value the records hide; past the
 * limit, to offer a person. A read-back the caller did not hear (they spoke before or over it, or went on
 * speaking after their answer) counts here too, so a read-back that is never heard comes to the same offer.
 */
function refused(t: Turn, action: string, why: string): string {
  const n = (t.st.refusals[action] = (t.st.refusals[action] ?? 0) + 1);
  const limit = t.deps.business.limits.refusalsPerAction;
  return n >= limit ? `${why} "${action}" has been refused ${n} times on this call: offer the caller a person rather than trying it again.` : why;
}

function gateReason(d: GateDecision, spec: ActionSpec | undefined, call: ToolCall, actions: string[]): string {
  if (spec === undefined) return `Refused: there is no action "${call.tool}". The actions are: ${actions.join(', ')}.`;
  const failed = d.rules.find((r) => !r.pass);
  return scrubOf(spec, call)(`Refused by the business's rules (${d.reason ?? d.verdict})${failed ? `: ${failed.description}` : ''}.`);
}

/** A tool's result as the model is sent it. */
const resultText = (r: unknown): string => (typeof r === 'string' ? r : r === undefined ? 'done' : JSON.stringify(r));

/** The most characters of a result the audit keeps. */
const RESULT_RECORDED_MAX = 600;

/**
 * Runs an action the gate allowed, with the call's key; a throw is the action's failure, said to the model.
 * Its result (or failure) is recorded in the audit beside the gate's row, as the model is sent it, the call's
 * values that are recorded masked masked, cut to RESULT_RECORDED_MAX.
 */
async function runTool(t: Turn, name: string, params: Record<string, string>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const impl = Object.hasOwn(t.deps.tools, name) ? t.deps.tools[name] : undefined;
  let ran: { ok: true; result: unknown } | { ok: false; error: string };
  if (impl === undefined) ran = { ok: false, error: `the action "${name}" has no code` };
  else {
    try {
      ran = { ok: true, result: await impl(params, { key: idempotencyKey(t.st.callId, name, params), texts: t.deps.texts, caller: t.st.caller, env: t.deps.env ?? (() => undefined) }) };
    } catch (e) {
      ran = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const spec = Object.hasOwn(t.deps.business.actions, name) ? t.deps.business.actions[name] : undefined;
  const summary = scrubOf(spec, { tool: name, params })(ran.ok ? resultText(ran.result) : `Failed: ${ran.error}`);
  await record(t, { type: 'tool_result', detail: { tool: name, ok: ran.ok, summary: summary.length > RESULT_RECORDED_MAX ? `${summary.slice(0, RESULT_RECORDED_MAX - 1)}…` : summary } });
  return ran;
}

/** A call in the turn's trace: its params as recorded, and its reason with any raw value of a masked param replaced as the params are. */
function traceTool(t: Turn, spec: ActionSpec | undefined, name: string, args: Record<string, unknown>, outcome: ConverseToolOutcome, reason?: string): void {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) raw[k] = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  const scrub = scrubOf(spec, { tool: name, params: raw });
  t.tools.push({ name, args: recordedArgs(spec, args), outcome, ...(reason !== undefined ? { reason: scrub(reason) } : {}) });
  const pairs = saidPairs(spec, { tool: name, params: raw }, shownParams(t.deps.business, name, raw, 'en', t.st.seen, t.st.caller.number));
  t.masked.push(...pairs);
  // On a call a value is said as the voice is sent it (speakable.ts): masked in that form too.
  for (const [value, form] of pairs) {
    const spoken = speakableOn(t.st, value);
    if (spoken !== value) t.masked.push([spoken, form]);
  }
}

/**
 * The actions the turn offers the model: its journey's (offeredActions; every action with no journeys), and on an
 * unclear turn only the lookups among them, so a turn the line could not follow changes nothing.
 */
function offeredNow(t: Turn): string[] {
  const b = t.deps.business;
  const offered = offeredActions(b, t.st.journey);
  return t.unclear === undefined ? offered : offered.filter((n) => b.actions[n]?.kind === 'lookup');
}

/** What a refused end_call's result says of the words held with it, never said (holdsWords). */
const NOT_SAID = 'what you wrote with it was not said to the caller';

/**
 * Where the words held with a refused end_call would have been the caller's first reply after a change they confirmed ran
 * this turn (Turn.confirmedRan), they have not heard that it is done: the refusal says so, so the model's next reply tells
 * them. Context, never words for it. Empty otherwise.
 */
function unheardDone(t: Turn): string {
  if (!t.roundHeld || !t.confirmedRan) return '';
  const action = t.st.done?.at(-1)?.action;
  return action === undefined ? '' : ` The caller has not yet heard that "${action}" is done, so your next reply tells them that too.`;
}

/**
 * One round's calls, in order: each checked, put to the gate and run, or read back. Returns the results
 * the model is sent and the read-back said, if a change was read back. A call after a read-back in the
 * same round is refused: one confirmation at a time. Once the turn is stopped from outside, a call not yet
 * begun is not run (one already running finishes, and its result is kept).
 */
async function runCalls(t: Turn, calls: Extract<ModelEvent, { type: 'tool_call' }>[]): Promise<{ results: ModelContent[]; readBack: string | null }> {
  const b = t.deps.business;
  const results: ModelContent[] = [];
  let readBack: string | null = null;
  const error = (id: string, content: string): void => void results.push({ type: 'tool_result', id, content, isError: true });
  for (const c of calls) {
    const spec = Object.hasOwn(b.actions, c.name) ? b.actions[c.name] : undefined;
    if (cut(t)) {
      const why = 'Not run: the caller spoke before it ran.';
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (t.ending) {
      const why = 'Not run: the call is ending.';
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (t.st.pending !== null) {
      // One confirmation at a time: nothing else runs while the caller answers a read-back, and the call is
      // not ended under it. It counts toward no action's refusals: the action was only held, so calls made
      // together never steer the caller to a person.
      const why = `Not run: one confirmation at a time. The caller is answering the read-back of "${t.st.pending.action}"; ${c.name === END_CALL ? 'end the call after their answer' : 'call this again after their answer'}.`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'one-confirmation-at-a-time', pending: t.st.pending.action } });
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (c.name === END_CALL && t.unsentRefused !== undefined) {
      // One ask per refusal: the caller's next turn says whether they still want it, so no end_call of this turn ends the call.
      const action = t.unsentRefused;
      t.unsentEnds += 1;
      const why = `Not run: ${t.roundHeld ? `${NOT_SAID}, and ` : ''}the caller has not yet answered whether they still want "${action}": ask them if you have not, wait for their answer, and end the call after it if they do not want it.${unheardDone(t)}`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'unsent-asked', unsent: action } });
      traceTool(t, undefined, c.name, {}, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (c.name === END_CALL && t.st.unsent !== undefined) {
      // A change the caller turned down or cut into was never sent: the first end_call after it is refused, so the model
      // asks whether they still want it; the change is let go here, so the next end_call ends the call. Counted toward
      // no refusal: nothing about ending the call was wrong. A goodbye written with it that streamed as it came has been
      // said, and the model is told so (a person would add "before you go..."): context, never a script. One held while the
      // caller read as wrapping up (holdsWords) is never said, and the model is told that instead.
      const { action } = t.st.unsent;
      delete t.st.unsent;
      t.unsentRefused = action;
      t.unsentEnds += 1;
      const lead = t.roundSpoke ? 'Not run: you have said goodbye, but ' : t.roundHeld ? `Not run: ${NOT_SAID}, and ` : 'Not run: ';
      const why = `${lead}"${action}" was read back to the caller and not confirmed, so it was never done or sent, and the call goes on. Before ending it, ask the caller whether they still want it sent, as a person would (such as "Before you go, did you still want me to send that request?"), unless they have said they no longer want it; if they do, call "${action}" again and it is read back to them. Otherwise, end the call.${unheardDone(t)}`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'unsent-change', unsent: action } });
      traceTool(t, undefined, c.name, {}, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (c.name === END_CALL) {
      // The runtime's own action: no params, no confirmation, recorded; the call ends once the round's calls are done, on the
      // model's own goodbye, or the closing line where the model wrote none.
      await record(t, { type: 'converse_end', detail: { by: END_CALL } });
      traceTool(t, undefined, c.name, {}, 'ran');
      t.ending = true;
      results.push({ type: 'tool_result', id: c.id, content: 'The call is ending.' });
      continue;
    }
    const follows = followOnsOf(b).get(c.name);
    if (follows !== undefined) {
      // A follow-on runs only after the action it follows, on the caller's yes to that one: never at the model's call.
      const why = `Not run: "${c.name}" runs only after ${follows}, once the caller has said yes to it; it is never called directly.`;
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    if (hasJourneys(b) && spec !== undefined && !offeredNow(t).includes(c.name)) {
      // Not among the turn's actions (its journey's, the lookups alone on an unclear turn): a model's slip, or a caller's words naming it. Refused before
      // the gate, and counted toward no refusal, since nothing about the action itself was wrong.
      const why = `Not run: "${c.name}" is not available for what the caller is doing now.`;
      await record(t, { type: 'converse_refused', detail: { action: c.name, reason: 'not-offered', journey: t.st.journey?.active ?? 'root' } });
      traceTool(t, spec, c.name, c.args, 'refused', why);
      error(c.id, why);
      continue;
    }
    let params: Record<string, string> = {};
    if (spec !== undefined) {
      const checked = checkArgs(spec, c.args, t.st.seen, t.todayIso, t.st.caller.number);
      if (!checked.ok) {
        traceTool(t, spec, c.name, c.args, 'invalid', checked.reason);
        error(c.id, checked.reason);
        continue;
      }
      params = checked.params;
    }
    const call: ToolCall = { tool: c.name, params };
    // A change called again with the same values after the caller spoke over its read-back before hearing it is read back
    // held (agent.yaml's readBacks.holdAfterCut): whole, not interruptible, its brief version where the action has one.
    const held = spec?.kind === 'change' && holdsNow(t, c.name);
    // A correction after a read-back heard and turned down is read back by its changes alone, held where read-backs of it
    // are; otherwise a held read-back is the brief one, where the action has it.
    const kept = t.st.heardReadBack;
    const changes = spec?.kind === 'change' && kept?.action === c.name ? changedParams(b, c.name, params, kept.params, 'en') : null;
    const brief = held && changes === null && spec.readBackBrief !== undefined;
    const d = await gate(t, spec, call, confirmedHashFor(call, t.st.pending), (dd) => (held && awaitsConfirmation(dd) ? { held: true, ...(brief ? { brief: true } : {}) } : {}));
    if (spec !== undefined && spec.kind === 'change' && awaitsConfirmation(d)) {
      // As the channel says it (speakable on a call): the text waiting for the yes is the text the caller hears, so
      // what the carrier reports played is compared with it as it was sent (readBackHeard). A correction of a read-back
      // the caller heard and did not confirm is read back by its changed values alone, where the business words it
      // (readBackChange); the yes to it confirms every value, its hash over all of them, as on the full read-back.
      const words = brief
        ? readBackBriefText(b, c.name, params, 'en', t.st.seen, t.st.caller.number)
        : changes === null ? readBackText(b, c.name, params, 'en', t.st.seen, t.st.caller.number) : shortReadBackText(b, c.name, params, changes, 'en', t.st.seen, t.st.caller.number);
      const text = speakableOn(t.st, words);
      const shape: Pick<PendingReadBack, 'changes' | 'held' | 'brief'> = { ...(changes !== null ? { changes } : {}), ...(held ? { held: true as const } : {}), ...(brief ? { brief: true as const } : {}) };
      t.st.pending = { action: c.name, params, hash: confirmationHash(params, confirmedFields(spec)), text, id: c.id, ...shape };
      t.readBack = { text, ...shape };
      traceTool(t, spec, c.name, params, 'readBack');
      readBack = text;
      continue;
    }
    if (d.verdict !== 'ALLOW') {
      const why = gateReason(d, spec, call, hasJourneys(b) ? offeredNow(t) : Object.keys(b.actions));
      traceTool(t, spec, c.name, spec === undefined ? c.args : params, 'refused', why);
      error(c.id, refused(t, c.name, why));
      continue;
    }
    const ran = await runTool(t, c.name, params);
    if (!ran.ok) {
      traceTool(t, spec, c.name, params, 'failed', ran.error);
      error(c.id, `Failed: ${ran.error}`);
      continue;
    }
    // Each lookup's latest results replace its earlier ones: a slot is held to what it returned last.
    if (spec?.kind === 'lookup') t.st.seen[c.name] = { results: Array.isArray(ran.result) ? ran.result : [ran.result], atMs: t.deps.now().getTime() };
    traceTool(t, spec, c.name, params, 'ran');
    results.push({ type: 'tool_result', id: c.id, content: resultText(ran.result) });
  }
  return { results, readBack };
}

/**
 * A request's outcome; a failure says whether anything of it was said, whether it never began (stalled), and
 * whether the provider refused it for its rate limit (`rateLimited`, with the wait it asked for where it named one).
 */
type Round =
  | { ok: true; calls: Extract<ModelEvent, { type: 'tool_call' }>[]; text: string }
  | { ok: false; error: string; spoke: boolean; stalled: boolean; rateLimited?: { retryAfterMs?: number } };

const TIMED_OUT = Symbol('timed out');
const STOPPED = Symbol('stopped');

/** A promise that resolves to STOPPED once `stop` is aborted. */
const stoppedBy = (stop: AbortSignal): Promise<typeof STOPPED> =>
  new Promise((resolve) => (stop.aborted ? resolve(STOPPED) : stop.addEventListener('abort', () => resolve(STOPPED), { once: true })));

/** `p`, or TIMED_OUT once `ms` have passed first. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms))))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request to the model, streamed: its text to the speaker until its first call (text after a call is
 * written without the call's result, and is dropped), its calls collected. It fails on an error event, a
 * thrown stream, nothing at all (but where `emptyOk`: the first answer to the check after speaking's note, for
 * which nothing at all is a correction declined), a reply cut off at the token limit, no event within
 * `firstWaitMs` at first and the model's time after, or `stop` aborted (the route changed the journey, or the
 * turn was stopped from outside: the request is aborted at once). The request's own signal is aborted with the
 * turn's (Turn.signal) the moment it is.
 */
async function streamOnce(t: Turn, sp: Speaker, req: ModelRequest, firstWaitMs: number, deadline: number, emptyOk: boolean, waitedMs = 0, stop?: AbortSignal): Promise<Round> {
  const controller = new AbortController();
  const outer = t.signal;
  const abortWithTurn = (): void => controller.abort();
  if (outer?.aborted === true) controller.abort();
  else outer?.addEventListener('abort', abortWithTurn, { once: true });
  const stopped = stop === undefined ? null : stoppedBy(stop);
  const started = Date.now();
  const iter = t.deps.model.stream(req, controller.signal)[Symbol.asyncIterator]();
  const calls: Extract<ModelEvent, { type: 'tool_call' }>[] = [];
  let text = '';
  let first = true;
  let firstMs: number | null = null;
  let failed: string | undefined;
  const fail = (error: string, stalled = false, rateLimited?: { retryAfterMs?: number }): Round => {
    failed = error;
    controller.abort();
    void Promise.resolve(iter.return?.()).catch(() => undefined);
    return { ok: false, error, spoke: sp.spoke, stalled, ...(rateLimited !== undefined ? { rateLimited } : {}) };
  };
  try {
    for (;;) {
      // The first event within firstWaitMs, and every event before the attempt's deadline: a model that
      // trickles its answer is bounded as one that never starts.
      const wait = Math.min(first ? firstWaitMs : Infinity, deadline - Date.now());
      let next: IteratorResult<ModelEvent> | typeof TIMED_OUT | typeof STOPPED;
      try {
        next = await within(stopped === null ? iter.next() : Promise.race([iter.next(), stopped]), wait);
      } catch (e) {
        return fail(`invalid: the stream threw (${e instanceof Error ? e.name : 'error'})`);
      }
      if (next === STOPPED) return fail(cut(t) ? 'interrupted: the turn was stopped from outside' : 'aborted: the route changed the journey');
      if (next === TIMED_OUT) return first ? fail(`timeout: no answer began within ${Math.round(wait)} ms`, true) : fail(`timeout: the answer was not done within the model's ${t.deps.business.model.timeoutMs} ms`);
      if (next.done) break;
      if (first) firstMs = Date.now() - started;
      first = false;
      const ev = next.value;
      if (ev.type === 'text') {
        if (calls.length === 0) {
          text += ev.delta;
          sp.delta(ev.delta);
        }
      } else if (ev.type === 'tool_call') calls.push(ev);
      else if (ev.type === 'done') {
        t.model.usage.inputTokens += ev.usage.inputTokens;
        t.model.usage.outputTokens += ev.usage.outputTokens;
        // Cut off at the token limit: what it was writing is unfinished, so the turn fails (its last sentence, never said, is dropped).
        if (ev.stop === 'length') return fail(`length: the reply reached the ${t.deps.business.model.maxTokens}-token limit`);
        break;
      } else return fail(`${ev.kind}: ${ev.detail}`, false, ev.kind === 'rate_limited' ? (ev.retryAfterMs !== undefined ? { retryAfterMs: ev.retryAfterMs } : {}) : undefined);
    }
  } finally {
    outer?.removeEventListener('abort', abortWithTurn);
    const ms = Date.now() - started;
    t.model.ms += ms;
    (t.model.requests ??= []).push({ firstMs, ms, ...(waitedMs > 0 ? { waitedMs } : {}), ...(failed !== undefined ? { error: failed } : {}), ...(t.correcting ? { correction: true as const } : {}) });
  }
  if (text.trim() === '' && calls.length === 0 && !emptyOk) {
    const r = fail('empty: the model said nothing and called nothing');
    // The request is timed already; its failure is this.
    t.model.requests!.at(-1)!.error = failed;
    return r;
  }
  return { ok: true, calls, text };
}

/**
 * The conversation as the model is sent it. A conversation the line opened (the greeting) starts with a
 * note that the call is connected, on the caller's side: a provider may take a conversation only from
 * the user's side.
 */
function requestMessages(st: ConverseState): ModelMessage[] {
  const messages = structuredClone(st.messages);
  if (messages[0]?.role !== 'assistant') return messages;
  return [{ role: 'user', content: [{ type: 'text', text: st.channel === 'voice' ? '[The call is connected.]' : '[The chat is open.]' }] }, ...messages];
}

/** The most times a request refused for the provider's rate limit is asked again, within a round. */
export const RATE_LIMIT_RETRIES = 2;
/** The first wait before a request refused for its rate limit is asked again, where the provider names none or one too long; it doubles each time. */
export const RATE_LIMIT_BACKOFF_MS = 250;

/** Waits `ms`, or until `stop` is aborted. */
async function sleep(ms: number, stop?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slept = new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, ms))));
  try {
    await (stop === undefined ? slept : Promise.race([slept, stoppedBy(stop)]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One round: the request, and again where it failed before saying anything. A request the provider refused
 * for its rate limit is asked again after a wait (its Retry-After where it named one that leaves half the
 * model's time, else RATE_LIMIT_BACKOFF_MS doubling), up to RATE_LIMIT_RETRIES more times, each only while half
 * the model's time is left after the wait; each such answer is counted in the trace (`model.rateLimited`), and
 * the time waited (`model.rateLimitedMs`, and each request's `waitedMs`, the wait before it). Any other failure
 * is asked once more with the time left, only while half the model's time is left: a request that had not
 * begun within half the model's time (it is stopped then) is asked again with the rest, as half is left then,
 * but not after a rate limit's wait, which has spent some of it. `emptyOk` is streamOnce's, for the round's
 * first request and its asks again alike. A round whose `stop` is aborted ends at once, asked no more, and
 * its failure is not the turn's (the round is asked again with the new journey: routedRound); so too a round
 * of a turn stopped from outside (Turn.signal), which is asked nothing more.
 */
async function round(t: Turn, sp: Speaker, emptyOk = false, routeStop?: AbortSignal): Promise<Round> {
  // Words held while the caller may be wrapping up with a change unsent (holdsWords); a routed first round is held already,
  // and its route decides. A reading not yet in holds the round, and once in, a low one lets its words go on streaming.
  let over = false;
  if (!sp.holding && holdsWords(t) !== 'stream') {
    const unknown = holdsWords(t) === 'unknown';
    sp.hold();
    if (t.wrapUp !== undefined) t.wrapUp.held = true;
    if (unknown) void t.wrapUp?.asked?.then(() => {
      if (!over && sp.holding && holdsWords(t) === 'stream') sp.release();
    });
  }
  try {
    return await roundAsked(t, sp, emptyOk, routeStop);
  } finally {
    over = true;
  }
}

/** round's requests, once its words are held or not. */
async function roundAsked(t: Turn, sp: Speaker, emptyOk: boolean, routeStop: AbortSignal | undefined): Promise<Round> {
  const stop = routeStop !== undefined && t.signal !== undefined ? AbortSignal.any([routeStop, t.signal]) : routeStop ?? t.signal;
  const b = t.deps.business;
  const req: ModelRequest = { system: systemPrompt(b, t.st, t.deps.now(), t.unclear), messages: requestMessages(t.st), tools: toolsOf(b, offeredNow(t), t.st.channel), maxTokens: b.model.maxTokens, ...(b.model.effort !== undefined ? { effort: b.model.effort } : {}) };
  const budget = b.model.timeoutMs;
  const start = Date.now();
  const deadline = start + budget;
  let limited = 0;
  let retried = false;
  // Read at each use: the round's stop may be aborted while it waits.
  const stopped = (): boolean => stop?.aborted === true;
  let r = await streamOnce(t, sp, req, budget / 2, deadline, emptyOk, 0, stop);
  while (!r.ok) {
    if (stopped()) break;
    t.model.error = r.error;
    if (r.spoke) break;
    if (r.rateLimited !== undefined) {
      t.model.rateLimited = (t.model.rateLimited ?? 0) + 1;
      if (limited >= RATE_LIMIT_RETRIES) break;
      const left = (wait: number): number => deadline - Date.now() - wait;
      const asked = r.rateLimited.retryAfterMs;
      const wait = asked !== undefined && left(asked) >= budget / 2 ? asked : RATE_LIMIT_BACKOFF_MS * 2 ** limited;
      if (left(wait) < budget / 2) break;
      limited += 1;
      sp.abandon();
      t.model.retried = true;
      t.model.rateLimitedMs = (t.model.rateLimitedMs ?? 0) + wait;
      await sleep(wait, stop);
      if (stopped()) break;
      r = await streamOnce(t, sp, req, budget / 2, deadline, emptyOk, wait, stop);
      continue;
    }
    // Half the model's time left: a stall of the round's first request leaves just that, a stall after a wait less.
    const halfLeft = deadline - Date.now() >= budget / 2 || (r.stalled && limited === 0);
    if (retried || !halfLeft) break;
    // Nothing was said: the words of a sentence not yet finished are dropped, and the model asked again.
    retried = true;
    sp.abandon();
    t.model.retried = true;
    r = await streamOnce(t, sp, req, deadline - Date.now(), deadline, emptyOk, 0, stop);
  }
  return r;
}

/** routedRound's word that the turn is the third unclear one in a row: the call ends, and the model is asked nothing more. */
const UNCLEAR_END = Symbol('unclear end');

/**
 * A routed turn's first round, asked alongside its routing (docs/designs/2026-11-12-journeys.md, "Keeping latency
 * flat"): the round starts at once with the journey as it stands, its sentences held, and its calls, if any, wait
 * for the route (the round's result is acted on only once it is known). When the route is known (or
 * routing.timeoutMs has passed, routeOf's limit), the call's journey is set to it and:
 *
 * - where it leaves the journey's active task and phase as they were, the held sentences are said and the
 *   rest of the round goes straight out; a round that has already failed says none of what it held (the
 *   caller has heard nothing of it), and fails as any round does;
 * - otherwise the round's request is aborted, what it held dropped, its calls never run and nothing of it
 *   put in the conversation, and the round asked again, once, with the new journey and the model's whole
 *   time from then (the route's `restarted`). The stopped round's error and retry are not the turn's. So too
 *   where the route is unclear, whatever the journey: the round is asked again with the guidance goal and the
 *   lookups only (the turn's `unclear`);
 * - but on the third unclear turn in a row (UNCLEAR_ENDS_AT) the round is stopped and dropped and nothing asked
 *   again: UNCLEAR_END, and the turn ends the call (endUnclear).
 */
async function routedRound(t: Turn, sp: Speaker, emptyOk: boolean, routing: Promise<Routed>): Promise<Round | typeof UNCLEAR_END> {
  const j = t.st.journey!;
  const before = { error: t.model.error, retried: t.model.retried };
  const stop = new AbortController();
  sp.hold();
  const first = round(t, sp, emptyOk, stop.signal);
  const settled: { round?: Round } = {};
  // A first round that throws is the turn's error once the route is acted on, never a rejection left unhandled meanwhile.
  first.then((r) => (settled.round = r), () => undefined);
  try {
    const routed = await routing;
    t.st.journey = routed.next;
    t.route = routed.route;
    if (routed.noLongerWants !== undefined) noteWithdrawal(t, routed.noLongerWants.action, routed.noLongerWants.reading);
    if (routed.wrappingUp !== undefined) wrapUpRead(t, routed.wrappingUp);
    leaveOffJourney(t);
    const count = routed.route.unclear;
    if (count !== undefined && t.said !== null) t.unclear = { count, said: t.said };
    if (t.unclear === undefined && routed.next.active === j.active && routed.next.phase === j.phase) {
      if (cut(t) || (settled.round !== undefined && !settled.round.ok)) sp.discard();
      // Held to the round's end while the caller may be wrapping up with a change unsent (holdsWords): converse says or drops it.
      else if (holdsWords(t) === 'stream') sp.release();
      else if (t.wrapUp !== undefined) t.wrapUp.held = true;
      return await first;
    }
    stop.abort();
    await first;
    sp.discard();
  } catch (e) {
    // Anything that throws before the route is acted on stops the first round (never left streaming), and the
    // error is the turn's, as a round's own is on a business without journeys: one failed turn.
    stop.abort();
    await first.catch(() => undefined);
    throw e;
  }
  if (before.error === undefined) delete t.model.error;
  else t.model.error = before.error;
  if (before.retried === undefined) delete t.model.retried;
  else t.model.retried = before.retried;
  // Stopped from outside while the route was read: nothing is asked again, and the call does not end.
  if (cut(t)) return { ok: false, error: 'interrupted: the turn was stopped from outside', spoke: false, stalled: false };
  if (t.unclear !== undefined && t.unclear.count >= UNCLEAR_ENDS_AT) return UNCLEAR_END;
  t.route.restarted = true;
  return round(t, sp, emptyOk);
}

/**
 * The third unclear turn in a row: the line says the business's line for it (lines.unclear; the closing line where
 * a business has none, which agent.yaml's check refuses with journeys) and the call ends as end_call ends it, the
 * audit's converse_end naming why.
 */
async function endUnclear(t: Turn, sp: Speaker): Promise<void> {
  const lines = t.deps.business.lines;
  const line = lineFor(t, lines.unclear ?? lines.closing);
  await record(t, { type: 'converse_end', detail: { by: 'unclear' } });
  sp.line(line);
  add(t.st, 'assistant', [{ type: 'text', text: line }]);
  t.ended = 'unclear';
  t.st.ended = 'closing';
  t.out.end('closing');
}

/**
 * The model failed the turn: the recovery line, or past the call's budget the handoff line, and the call
 * ends with a person. Where an action the caller confirmed has just run, the caller hears the done line
 * first, and it stands for the recovery line: they need not say anything again. A model that used up its
 * rounds (`stuck`: it kept calling actions) is not asked to be heard again: the stuck line stands for the
 * recovery line.
 */
function failed(t: Turn, sp: Speaker, why: 'failed' | 'stuck' = 'failed'): void {
  const lines = t.deps.business.lines;
  t.st.failures += 1;
  const handoff = t.st.failures >= t.deps.business.limits.failuresPerCall;
  const said: string[] = [];
  const doneOwed = t.confirmedRan;
  if (doneOwed) {
    t.confirmedRan = false;
    said.push(lineFor(t, lines.done));
  }
  if (handoff) said.push(lineFor(t, lines.handoff));
  else if (said.length === 0) said.push(lineFor(t, why === 'stuck' ? lines.stuck : t.silence !== undefined && lines.silence !== undefined ? lines.silence : lines.recovery));
  said.forEach((line, i) => sp.line(line, i === said.length - 1));
  if (doneOwed) t.out.replied?.();
  add(t.st, 'assistant', said.map((text) => ({ type: 'text' as const, text })));
  if (handoff) {
    t.st.ended = 'handoff';
    t.out.end('handoff');
  }
}

/** Takes a carried note out of the conversation: the text block holding it, in the latest message on the caller's side. */
function dropNote(st: ConverseState, note: string): void {
  for (let m = st.messages.length - 1; m >= 0; m--) {
    const msg = st.messages[m]!;
    if (msg.role !== 'user') continue;
    const at = msg.content.findIndex((c) => c.type === 'text' && c.text === note);
    if (at < 0) return;
    msg.content.splice(at, 1);
    if (msg.content.length === 0) st.messages.splice(m, 1);
    return;
  }
}

/**
 * The model asked, round after round, until it replies with no call, a change is read back, or it fails.
 * A failure says the recovery line (failed), but `silent` (the check after speaking's correction): then
 * nothing more is said and nothing counted, and the failure is returned. With `silent`, a first answer of
 * nothing at all (no text and no call) is the correction declined: the model read its reply again and found
 * it right, so nothing is said or added to the conversation, and it is no failure (`declined`). With
 * `carried` (the turn's message carries a note from an earlier turn), a first answer of nothing at all is
 * the model taking the note's "say nothing of it" for the whole answer: the note is taken out of the
 * conversation and the model asked once more without it; that answer, empty or not, is taken as any is.
 * With `routing` (a routed caller turn), the first round is asked alongside it (routedRound); later rounds
 * are asked in the journey it decided. A turn stopped from outside (Turn.signal) stops here (interrupted).
 */
async function converse(t: Turn, sp: Speaker, silent = false, carried?: string, routing?: Promise<Routed>): Promise<{ ok: true; declined?: true } | { ok: false; error: string }> {
  let first = true;
  let route = routing;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (cut(t)) return interrupted(t, sp);
    const emptyOk = first && (silent || carried !== undefined);
    const r = route !== undefined ? await routedRound(t, sp, emptyOk, route) : await round(t, sp, emptyOk);
    route = undefined;
    first = false;
    // Stopped from outside while the model was asked: whatever the round came to (a client's abort reads as a timeout), it is no failure.
    if (cut(t)) return interrupted(t, sp);
    if (r === UNCLEAR_END) {
      await endUnclear(t, sp);
      return { ok: true };
    }
    if (r.ok && r.text.trim() === '' && r.calls.length === 0) {
      // Only a first answer may be empty (streamOnce's emptyOk).
      sp.abandon();
      if (silent) return { ok: true, declined: true };
      // The message's carried note answered with nothing: out with it, and asked again (no round spent).
      dropNote(t.st, carried!);
      t.carriedNoteDropped = true;
      i -= 1;
      continue;
    }
    if (!r.ok) {
      const said = sp.abandon();
      if (said !== '') {
        add(t.st, 'assistant', [{ type: 'text', text: said }]);
        t.own.push(said);
      }
      if (!silent) failed(t, sp);
      return { ok: false, error: r.error };
    }
    const final = r.calls.length === 0;
    // A round that only ends the call (nothing waits on a read-back) ends on its own words, where it wrote any: they are the goodbye.
    // Not while a change is kept unsent (or one refused an end_call this turn): that end_call is refused, the call goes on,
    // and the next round's words end the turn. Whether the caller withdrew it is read first, where it is being read.
    if (t.st.unsent !== undefined && r.calls.some((c) => c.name === END_CALL)) await settleWithdrawal(t);
    const goodbye = !final && t.st.pending === null && t.st.unsent === undefined && t.unsentRefused === undefined && r.calls.every((c) => c.name === END_CALL);
    // Words held to the round's end (holdsWords). Where the round calls end_call they wait for its calls, as the unsent rule
    // may refuse it: refused, they are never said, nor kept in the conversation as said (only their length is traced);
    // otherwise (and in every round with no end_call) they are said now, whole, before what the calls bring.
    const held = sp.holding;
    const wrote = r.text.trim();
    let ran: Awaited<ReturnType<typeof runCalls>> | undefined;
    let dropped = false;
    if (held && r.calls.some((c) => c.name === END_CALL)) {
      const refusedBefore = t.unsentEnds;
      t.roundSpoke = false;
      t.roundHeld = wrote !== '';
      try {
        ran = await runCalls(t, r.calls);
      } finally {
        t.roundHeld = false;
      }
      dropped = t.unsentEnds > refusedBefore;
    }
    let said = '';
    if (dropped) {
      sp.discard();
      if (wrote !== '' && t.wrapUp !== undefined) t.wrapUp.dropped = (t.wrapUp.dropped ?? 0) + wrote.length;
    } else {
      if (held) sp.release();
      said = sp.endRound(final || goodbye);
    }
    t.roundSpoke = said !== '';
    add(t.st, 'assistant', [...(said !== '' ? [{ type: 'text' as const, text: said }] : []), ...r.calls.map((c) => ({ type: 'tool_call' as const, id: c.id, name: c.name, args: c.args }))]);
    // The caller has heard a reply after the action they confirmed.
    if (said !== '') {
      if (t.confirmedRan) t.out.replied?.();
      t.confirmedRan = false;
      t.own.push(said);
    }
    if (final) return { ok: true };
    const { results, readBack } = ran ?? (await runCalls(t, r.calls));
    add(t.st, 'user', results);
    if (cut(t)) {
      // A read-back the caller never heard waits for no answer: nothing is done, and the model may call it again.
      if (readBack !== null) unheardReadBack(t);
      return interrupted(t, sp);
    }
    if (readBack !== null) {
      // A held read-back goes whole, not interruptible; the model's words before it went out as they came.
      const held = t.st.pending?.held === true;
      sp.line(readBack, true, held);
      // Said held: on the record of the read-back not heard, as the trace and the state show it.
      const action = t.st.pending!.action;
      const u = unheardOf(t, action);
      if (held && u !== undefined) t.st.unheardReadBacks = { ...t.st.unheardReadBacks, [action]: { ...u, held: true } };
      t.readBackSaid = true;
      return { ok: true };
    }
    if (t.ending) {
      // The model's own words written with end_call alone are the goodbye; the closing line is said where it wrote none.
      if (!goodbye || said === '') {
        const closing = lineFor(t, t.deps.business.lines.closing);
        sp.line(closing);
        add(t.st, 'assistant', [{ type: 'text', text: closing }]);
      }
      t.st.ended = 'closing';
      t.out.end('closing');
      return { ok: true };
    }
  }
  // Its rounds used up on calls: the caller asked nothing that needs saying again.
  if (!silent) failed(t, sp, 'stuck');
  return { ok: false, error: `stuck: still calling actions after ${MAX_ROUNDS} rounds` };
}

/**
 * The turn was stopped from outside (the caller spoke on a call): what the round had not said is dropped, what
 * it said is the line's in the conversation, and nothing more is said or asked: no recovery line, no failure
 * counted, no end.
 */
function interrupted(t: Turn, sp: Speaker): { ok: false; error: string } {
  const said = sp.abandon();
  if (said !== '') {
    add(t.st, 'assistant', [{ type: 'text', text: said }]);
    t.own.push(said);
  }
  return { ok: false, error: 'interrupted: the turn was stopped from outside' };
}

/** A read-back set waiting in a round the turn was stopped in, before the line said it: it waits for no answer, and its call has its result. */
function unheardReadBack(t: Turn): void {
  const p = t.st.pending;
  if (p === null) return;
  t.st.pending = null;
  delete t.readBack;
  const spec = Object.hasOwn(t.deps.business.actions, p.action) ? t.deps.business.actions[p.action] : undefined;
  // In the trace beside the call's read-back, so the console shows why it waits for no answer.
  traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the caller spoke before the line read it back');
  keepUnsent(t, p);
  add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: refused(t, p.action, 'Not read back: the caller spoke before it was read back, so nothing was done. Call it again to have it read back.'), isError: true }]);
}

/**
 * The check after speaking (docs/designs/2026-11-11-claims-check.md): once the turn's reply has been said,
 * the decision model reads the model's own words of it (never a fixed line or a read-back) against the
 * business information and the call's actions. A turn that ended the call, or in which the model said
 * nothing of its own, is not read, nor with agent.yaml's `checks.claims.mode` off. A reply read as
 * contradicted or not done at or over `correctAt` (with mode correct) goes back to the model with a note
 * marked as the line's own check, and the model is asked once more: its correction is said after the reply,
 * and may call actions, gated and read back as on any turn. The correction is not read again. A reading that
 * fails or comes late is an unread check: nothing is corrected.
 *
 * - **Declined:** the model, reading its reply again, may find it right after all and answer with nothing at
 *   all: nothing is said, it is no failure, the note is taken out of the conversation as if never sent (a
 *   model may not be sent an empty turn of its own), and the check says `declined`.
 * - **Failed:** a correction that fails (the model errs, is late, or keeps calling actions) is silent: no
 *   recovery line, no failure counted, no handoff, for the reply it would have corrected has been said and
 *   stands. Where it said nothing, the note (and whatever the correction called) is taken out of the
 *   conversation; where it said part of itself, what it said closes the conversation. The reply's own model
 *   error and retry stay the turn's: the correction's failure is the check's (`correctionFailed`,
 *   `correctionError`), and its requests are marked as the correction's.
 * - **Carried:** while a read-back waits for the caller's yes the model may not be asked now, so the note is
 *   kept in the call's state (ConverseState.carriedNote) and goes with the next message the model is sent
 *   (converseTurn), worded as about a reply said earlier; the check says `carried`.
 */
async function checkAfterSpeaking(t: Turn, sp: Speaker): Promise<void> {
  const claims = t.deps.business.checks.claims;
  if (claims.mode === 'off' || t.st.ended !== undefined || t.own.length === 0) return;
  const reply = t.own.join(' ');
  const started = Date.now();
  const state = claimsState(t.deps.business, t.st, t.todayIso, reply);
  const reading = await readClaims(t.deps.jev, state, t.deps.jevTimeoutMs);
  t.deps.onClaimsRead?.(t.st.callId, { turn: t.st.turnIndex, state, reading });
  const flagged: NonNullable<ConverseTraceRecord['check']>['flagged'] = [];
  if (reading !== null) {
    if (reading.contradicted >= claims.correctAt) flagged.push('contradicted');
    if (reading.notDone >= claims.correctAt) flagged.push('notDone');
    if (reading.gap >= claims.gapAt) flagged.push('gap');
  }
  const check: NonNullable<ConverseTraceRecord['check']> = { contradicted: reading?.contradicted ?? null, notDone: reading?.notDone ?? null, gap: reading?.gap ?? null, flagged, ms: Date.now() - started, corrected: false, correction: 0 };
  t.check = check;
  const wrong = flagged.includes('contradicted') || flagged.includes('notDone');
  if (reading === null || !wrong || claims.mode !== 'correct') return;
  if (t.st.pending !== null) {
    // A read-back waits for the caller's yes: the note goes with the next message the model is sent.
    t.st.carriedNote = checkNote(reply, reading, claims.correctAt, true);
    check.carried = true;
    return;
  }
  // The note is a message of its own on the caller's side (a model is sent a conversation that ends there),
  // marked as the line's own check; the system prompt says what such a note is.
  const before = { replies: t.replies.length, messages: t.st.messages.length, error: t.model.error, retried: t.model.retried };
  add(t.st, 'user', [{ type: 'text', text: checkNote(reply, reading, claims.correctAt) }]);
  t.correcting = true;
  const corrected = await converse(t, sp, true);
  t.correcting = false;
  check.corrected = true;
  check.correction = t.replies.length - before.replies;
  // The turn's model error and retry are the reply's own: the correction's go to the check.
  if (before.error === undefined) delete t.model.error;
  else t.model.error = before.error;
  if (before.retried === undefined) delete t.model.retried;
  else t.model.retried = before.retried;
  if (corrected.ok) {
    if (corrected.declined === true) {
      check.declined = true;
      t.st.messages.length = before.messages;
    }
    return;
  }
  check.correctionFailed = true;
  check.correctionError = corrected.error;
  if (check.correction === 0) t.st.messages.length = before.messages;
}

/** A confirmed action through the gate with the hash of exactly its own values (the read-back's, or a follow-on's own), run when allowed. */
async function runConfirmed(t: Turn, name: string, params: Record<string, string>, hash: string): Promise<{ outcome: 'ran' | 'refused' | 'failed'; text: string; why?: string }> {
  const spec = Object.hasOwn(t.deps.business.actions, name) ? t.deps.business.actions[name] : undefined;
  const call: ToolCall = { tool: name, params };
  const d = await gate(t, spec, call, hash);
  if (d.verdict !== 'ALLOW') {
    const why = gateReason(d, spec, call, Object.keys(t.deps.business.actions));
    return { outcome: 'refused', text: refused(t, name, why), why };
  }
  const ran = await runTool(t, name, params);
  return ran.ok ? { outcome: 'ran', text: resultText(ran.result) } : { outcome: 'failed', text: `Failed: ${ran.error}`, why: ran.error };
}

/** How the result of a read-back's call opens once the caller has answered it: the caller's words are in it (applyHeard's turn boundary). */
const READ_BACK_ANSWER = 'Read back to the caller: "';
/** How that result opened before 2026-11-25, in a conversation saved then: still the caller's words. */
const READ_BACK_ANSWER_BEFORE = 'The line read back: "';

/**
 * What a read-back the caller did not confirm leaves the model to know: the goal (a yes to the read-back) and
 * what a yes elsewhere is worth, never words for it to say.
 */
const ONLY_THE_READ_BACK = 'Nothing is done until the caller hears the action\'s details read back and says yes to that read-back: a yes to a question of your own confirms nothing. As soon as you have what they want, a correction or a new detail they give included, call the action again with it in that same reply, and it is read back to them: never wait for them to ask for it.';

/**
 * What an answer to a read-back that is not confirmed leaves the model to know, said after the caller's words, which
 * may hold a yes: the change is not in, so the caller is neither told it is nor thanked for confirming it (the prompt's
 * third rule). A simulated call (2026-11-26) answered "Yes, that's right. ... I'm not sure about the December 1 date,
 * but ..."; told only "The caller did not confirm" before those words, the model said "Thanks for confirming that" and
 * goodbye, and the caller hung up believing the request was in.
 */
const NOT_IN = 'The change is not in: the caller must not be told it is, or thanked for confirming it (rule 3).';

/**
 * The same, where the decision model read the answer and did not read a clear yes: why the line did not take it, and
 * that the caller's own words say what is left to take up with them.
 */
const NOT_A_CLEAR_YES = 'The line did not read their answer as a clear yes to all of it, so the change is not in: the caller must not be told it is, or thanked for confirming it (rule 3). Where their words show what they were unsure of, that is what to take up with them.';

/**
 * A change the caller did not confirm is kept as unsent (ConverseState.unsent), replacing any kept before it, so the
 * call does not end without the caller asked whether they still want it.
 */
function keepUnsent(t: Turn, p: PendingReadBack): void {
  t.st.unsent = { action: p.action };
}

/**
 * A read-back the caller heard and did not confirm is kept (ConverseState.heardReadBack), replacing any kept before
 * it, short or full alike, with the values it was read with: a correction called next is read against them. Only
 * where the caller heard it: one they spoke before or over leaves the one kept before it.
 */
function keepHeard(t: Turn, p: PendingReadBack): void {
  t.st.heardReadBack = { action: p.action, params: { ...p.params } };
}

/**
 * A read-back the caller did not hear is kept by its action (ConverseState.unheardReadBacks), on a call with agent.yaml's
 * readBacks.holdAfterCut on, so every later read-back of its action is held until the change is let go (the maintainer's
 * decision, 2026-11-26). `held` says a held one has been said for it.
 */
function keepUnheard(t: Turn, p: PendingReadBack): void {
  if (!holding(t)) return;
  const before = t.st.unheardReadBacks?.[p.action];
  const held = p.held === true || before?.held === true;
  t.st.unheardReadBacks = { ...t.st.unheardReadBacks, [p.action]: { params: { ...p.params }, ...(held ? { held: true as const } : {}) } };
}

/** Whether read-backs are held on this call: a call, with agent.yaml's readBacks.holdAfterCut on. */
const holding = (t: Turn): boolean => t.st.channel === 'voice' && t.deps.business.readBacks.holdAfterCut;

/** The read-back not heard kept for `action`, where there is one. */
const unheardOf = (t: Turn, action: string): UnheardReadBack | undefined => (t.st.unheardReadBacks !== undefined && Object.hasOwn(t.st.unheardReadBacks, action) ? t.st.unheardReadBacks[action] : undefined);

/** Whether a read-back of `action` is said held now: a read-back of it was not heard on this call, and the change has not been let go since (whatever values it has now). */
const holdsNow = (t: Turn, action: string): boolean => holding(t) && unheardOf(t, action) !== undefined;


/** The not-heard read-back of `action` let go, its entry taken out (and the record with its last entry). */
function letGoUnheard(t: Turn, action: string): void {
  const all = t.st.unheardReadBacks;
  if (all === undefined || !Object.hasOwn(all, action)) return;
  const { [action]: _gone, ...rest } = all;
  if (Object.keys(rest).length === 0) delete t.st.unheardReadBacks;
  else t.st.unheardReadBacks = rest;
}

/** The read-backs kept for `action` let go: the one heard (a correction's base) and the one not heard (a hold's). */
function letGoReadBacks(t: Turn, action: string): void {
  if (t.st.heardReadBack?.action === action) delete t.st.heardReadBack;
  letGoUnheard(t, action);
}

/** How a read-back was said (short, held, brief), as the trace keeps it beside its text. */
const changesOf = (p: PendingReadBack): Pick<PendingReadBack, 'changes' | 'held' | 'brief'> => ({
  ...(p.changes !== undefined ? { changes: p.changes } : {}),
  ...(p.held === true ? { held: true as const } : {}),
  ...(p.brief === true ? { brief: true as const } : {}),
});

/** What a change kept unsent is for, in the business's own words (its action's `about`), as the decision model is sent it: never its values. */
function unsentAbout(t: Turn, action: string): string {
  const spec = Object.hasOwn(t.deps.business.actions, action) ? t.deps.business.actions[action] : undefined;
  return (spec?.about ?? action).trim().replace(/\s+/g, ' ');
}

/**
 * The decision model's reading of whether the caller no longer wants the change kept unsent for `action` (null: asked,
 * and it failed or was late), traced; at WITHDRAWN_AT or above, the change is let go, so the call may end on the first
 * end_call. A reading for a change no longer kept is traced only.
 */
function noteWithdrawal(t: Turn, action: string, reading: number | null): void {
  t.unsent = { ...t.unsent, action, noLongerWants: reading };
  if (reading !== null && reading >= WITHDRAWN_AT && t.st.unsent?.action === action) {
    delete t.st.unsent;
    t.unsent.cleared = 'withdrawn';
    letGoReadBacks(t, action);
  }
}

/** The reading asked on its own (no routing this turn), once: awaited where an end_call depends on it, and at the turn's end. */
async function settleWithdrawal(t: Turn): Promise<void> {
  const w = t.withdrawal;
  if (w === undefined || w.settled) return;
  w.settled = true;
  noteWithdrawal(t, w.action, await w.reading);
}

/**
 * A change kept unsent is let go once the call's journey no longer offers its action (a drop, a switch, or the journey
 * finished): it is then not what the caller is doing, and the model could not call it again to read it back.
 */
function leaveOffJourney(t: Turn): void {
  const b = t.deps.business;
  if (!hasJourneys(b) || t.st.journey === undefined) return;
  const offered = offeredActions(b, t.st.journey);
  // The read-back kept for a correction goes with it: its action can no longer be called again to be read back.
  const kept = t.st.heardReadBack;
  if (kept !== undefined && !offered.includes(kept.action)) delete t.st.heardReadBack;
  for (const action of Object.keys(t.st.unheardReadBacks ?? {})) if (!offered.includes(action)) letGoUnheard(t, action);
  const u = t.st.unsent;
  if (u === undefined || offered.includes(u.action)) return;
  delete t.st.unsent;
  t.unsent = { ...t.unsent, action: u.action, cleared: 'journey' };
}

/** A read-back answer's reading as the trace keeps it. */
const readingOf = (r: ReadBackReading): Omit<NonNullable<ConverseTraceRecord['readBack']>, 'text' | 'confirmed'> => ({
  yes: r.yes,
  no: r.no,
  ...(r.change !== undefined ? { change: r.change } : {}),
  ...(r.withdraws !== undefined ? { withdraws: r.withdraws } : {}),
});

/** What came of the caller's answer to a read-back: the action ran; it did not; or it did not and the line asked what to change (lines.notConfirmed). */
type ReadBackAnswer = 'ran' | 'notRun' | 'asked';

/**
 * The caller answered a read-back: a clear yes runs the action and its follow-ons; anything else goes back to
 * the model. An action that completes the active journey moves it to its after phase. An answer over a read-back
 * the caller did not hear (readBackHeard: they began before it, or cut in before it was nearly done) confirms
 * nothing, and the decision model is not asked. A turn stopped from outside before the action runs (the caller
 * went on speaking) confirms nothing either (wentOn); one stopped once it runs finishes it, with its follow-ons.
 * A clear no that says nothing of what should be different (isDeclinedWithoutChange), where the business has
 * lines.notConfirmed, is answered by the line word for word, the line's own in the conversation (`asked`: the
 * turn's reply is that line, and the model is not asked); the model is told the line asked, so it answers what
 * the caller says next. Any answer not confirmed keeps the change as unsent (keepUnsent); a yes lets it go.
 */
async function answered(t: Turn, sp: Speaker, said: string, heard: Heard | undefined): Promise<ReadBackAnswer> {
  const p = t.st.pending!;
  t.st.pending = null;
  const b = t.deps.business;
  const spec = b.actions[p.action];
  const readLine = `${READ_BACK_ANSWER}${p.text}"`;
  // The caller's words as the model is sent them: the note's mark rewritten wherever they wrote it.
  const words = neutralised(said);
  if (!readBackHeard(p.text, heard)) {
    t.readBack = { text: p.text, ...changesOf(p), confirmed: false };
    traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the caller spoke over the read-back');
    keepUnsent(t, p);
    keepUnheard(t, p);
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: refused(t, p.action, `${readLine} Not done: nothing was changed, booked or sent. The caller spoke over the read-back before it finished, so it is not confirmed. They said: "${words}" ${ONLY_THE_READ_BACK} ${NOT_IN}`) }]);
    return 'notRun';
  }
  // Stopped before the decision model is asked: the caller went on speaking, and nothing runs.
  if (cut(t)) return wentOn(t, p, words);
  const reading = await readYesNo(t.deps.jev, p.text, said, t.deps.jevTimeoutMs, dayInWords(t.todayIso));
  // Stopped while it read the answer (the caller went on speaking): a yes before more words confirms nothing,
  // and the next turn has both (the read-back's result carries this answer).
  if (cut(t)) return wentOn(t, p, words, reading);
  const yes = isConfirmed(reading);
  t.readBack = { text: p.text, ...changesOf(p), ...(reading !== null ? readingOf(reading) : {}), confirmed: yes };
  if (reading === null) {
    // The decision model timed out or failed: what the caller meant is not known, and nothing runs.
    traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the answer could not be read');
    keepUnsent(t, p);
    keepHeard(t, p);
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${readLine} Not done: nothing was changed, booked or sent. The caller's answer could not be read, so it is not known whether they confirmed. ${ONLY_THE_READ_BACK} They said: '${words}' ${NOT_IN}` }]);
    return 'notRun';
  }
  if (!yes && isWithdrawn(reading)) {
    // The caller wants none of it: nothing is kept unsent, and no line asks what to change.
    traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the caller withdrew it');
    if (t.st.unsent?.action === p.action) delete t.st.unsent;
    letGoReadBacks(t, p.action);
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${readLine} Not done: nothing was changed, booked or sent. The caller withdrew it: they do not want it at all, so do not ask them about it again unless they bring it up. ${ONLY_THE_READ_BACK} They said: '${words}'` }]);
    return 'notRun';
  }
  if (!yes) {
    traceTool(t, spec, p.action, p.params, 'notConfirmed');
    keepUnsent(t, p);
    keepHeard(t, p);
    const notConfirmed = b.lines.notConfirmed;
    if (notConfirmed !== undefined && isDeclinedWithoutChange(reading)) {
      // A clear no with nothing said of what should be different: the business's line asks, word for word.
      const line = lineFor(t, notConfirmed);
      add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${readLine} Not done: nothing was changed, booked or sent. The caller did not confirm, and they were asked, in the business's own words, what they would like to change or whether to cancel: "${line}" Answer what they say next. ${ONLY_THE_READ_BACK} They said: '${words}' ${NOT_A_CLEAR_YES}` }]);
      sp.line(line);
      add(t.st, 'assistant', [{ type: 'text', text: line }]);
      return 'asked';
    }
    add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${readLine} Not done: nothing was changed, booked or sent. The caller did not confirm. ${ONLY_THE_READ_BACK} They said: '${words}' ${NOT_A_CLEAR_YES}` }]);
    return 'notRun';
  }
  // A yes to a read-back of the change kept unsent lets it go, whatever then comes of running it.
  if (t.st.unsent?.action === p.action) delete t.st.unsent;
  letGoReadBacks(t, p.action);
  await record(t, { type: 'confirmed', detail: { action: p.action, hash: p.hash, yes: reading!.yes, no: reading!.no, ...(p.changes !== undefined ? { short: true, changes: p.changes } : {}), ...(p.held === true ? { held: true } : {}), ...(p.brief === true ? { brief: true } : {}) } });
  const parent = await runConfirmed(t, p.action, p.params, p.hash);
  traceTool(t, spec, p.action, p.params, parent.outcome === 'ran' ? 'confirmed' : parent.outcome, parent.why);
  const done = [`${p.action}: ${parent.text}`];
  if (parent.outcome === 'ran') {
    t.confirmedRan = true;
    // The line's own record of what has been done, told to the model on every request from now on; kept as soon
    // as the change has run (its follow-ons' results joining it as they run), so a turn that throws keeps it.
    (t.st.done ??= []).push({ action: p.action, readBack: p.text, results: done, ...(spec !== undefined ? { carried: carriedOf(spec, p.params) } : {}) });
    t.out.confirmed?.();
    const j = t.st.journey;
    if (hasJourneys(b) && j !== undefined) {
      const next = completeJourney(b, j, p.action);
      if (next !== j) {
        t.st.journey = next;
        t.journeyEnded = { journey: j.active!, how: 'done' };
        leaveOffJourney(t);
      }
    }
  }
  // Follow-ons run only after their parent ran, each with the parent's confirmed values by name (agent.yaml's
  // check makes every param a follow-on takes one its parent has), its own hash, and a row naming the yes.
  for (const name of parent.outcome === 'ran' ? spec?.then ?? [] : []) {
    const follow = Object.hasOwn(b.actions, name) ? b.actions[name] : undefined;
    if (follow === undefined) continue;
    const filled = Object.fromEntries(Object.keys(follow.params).map((k) => [k, p.params[k] ?? '']));
    const checked = checkArgs(follow, filled, t.st.seen, t.todayIso, t.st.caller.number);
    if (!checked.ok) {
      traceTool(t, follow, name, filled, 'invalid', checked.reason);
      done.push(`${name}: not run (${checked.reason})`);
      continue;
    }
    const hash = confirmationHash(checked.params, confirmedFields(follow));
    await record(t, { type: 'confirmed', detail: { action: name, parent: p.action, parentHash: p.hash, hash } });
    const ran = await runConfirmed(t, name, checked.params, hash);
    traceTool(t, follow, name, checked.params, ran.outcome, ran.why);
    done.push(`${name}: ${ran.text}`);
  }
  add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: `${readLine} The caller confirmed; done: ${done.join('; ')}. They said: '${words}'`, ...(parent.outcome === 'ran' ? {} : { isError: true }) }]);
  return parent.outcome === 'ran' ? 'ran' : 'notRun';
}

/**
 * What a change carried, as the model is told it in the line's record of the call: each of its action's params in
 * the order agent.yaml gives them, with its value; a phone number by its last four only (the model never sees the
 * caller's whole number, and a number the caller gave needs no more to be told apart); an empty one as nothing.
 */
function carriedOf(spec: ActionSpec, params: Readonly<Record<string, string>>): string[] {
  return Object.entries(spec.params).map(([name, ps]) => {
    const value = (params[name] ?? '').trim();
    if (value === '') return `${name}: nothing`;
    return `${name}: ${ps.type === 'phone' ? `the number ending ${value.replace(/\D/g, '').slice(-4)}` : value}`;
  });
}

/**
 * The caller's answer to a read-back, its turn stopped from outside before anything ran (they went on speaking,
 * plan 2's ruling R-h): nothing runs, whatever the answer was, and the model is told so, as on any answer not
 * confirmed; the words that followed come with the next turn.
 */
function wentOn(t: Turn, p: PendingReadBack, words: string, reading?: ReadBackReading | null): 'notRun' {
  const spec = Object.hasOwn(t.deps.business.actions, p.action) ? t.deps.business.actions[p.action] : undefined;
  t.readBack = { text: p.text, ...changesOf(p), ...(reading != null ? readingOf(reading) : {}), confirmed: false };
  traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the caller went on speaking');
  keepUnsent(t, p);
  keepHeard(t, p);
  const content = `${READ_BACK_ANSWER}${p.text}" Not done: nothing was changed, booked or sent. The caller went on speaking after their answer, so it is not confirmed. They said: "${words}" ${ONLY_THE_READ_BACK} ${NOT_IN}`;
  // A yes lost to the words that followed it (or an answer stopped before it was read) counts as a read-back not
  // heard; an answer read as anything but a yes (a no, a correction, or one that could not be read) is the
  // caller's answer, as answered() takes it, and counts nothing.
  const counts = reading === undefined || isConfirmed(reading);
  add(t.st, 'user', [{ type: 'tool_result', id: p.id, content: counts ? refused(t, p.action, content) : content }]);
  return 'notRun';
}

/** The text of the line's last words before the caller's turn: a read-back waiting for its answer, else the last message of the line's with text. */
function lastReplyOf(st: ConverseState): string | null {
  if (st.pending !== null) return st.pending.text;
  for (let m = st.messages.length - 1; m >= 0; m--) {
    const msg = st.messages[m]!;
    if (msg.role !== 'assistant') continue;
    const text = msg.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ').trim();
    if (text !== '') return text;
  }
  return null;
}

/** A caller turn's route: the journey it leaves the call in, and the route as the trace keeps it. */
interface Routed {
  next: JourneyState;
  route: NonNullable<Turn['route']>;
  /** Where the routing request also asked whether the caller no longer wants the change kept unsent: its action and the reading (null: none). */
  noLongerWants?: { action: string; reading: number | null };
  /** Where the routing request also asked whether the caller is wrapping up the call (Turn.wrapUp): the reading (null: none). */
  wrappingUp?: number | null;
}

/**
 * Routes the caller's turn among the journeys from `j`, the journey as it stands (docs/designs/2026-11-12-journeys.md,
 * "Routing"): the decision model is asked which task the caller wants now, within routing.timeoutMs, and code
 * decides from its reading (decideRoute). A decision model that errs or is late, or anything here that throws,
 * leaves the journey as it was (carry, with no reading): routing never fails a turn, and `timedOut` says it was
 * late. It never rejects. Nothing is set here: routedRound sets the call's journey and the turn's route once
 * it is known.
 */
async function routeOf(t: Turn, j: JourneyState, said: string, lastReply: string | null): Promise<Routed> {
  const b = t.deps.business;
  const started = Date.now();
  // While a change is kept unsent, the same request asks whether the caller no longer wants it (a read-back's answer reads its own).
  const unsent = t.st.unsent !== undefined && t.answersReadBack !== true ? t.st.unsent.action : null;
  // While a change could be left unsent (Turn.wrapUp), the same request asks whether the caller is wrapping up the call.
  const wrapUp = t.wrapUp !== undefined && t.wrapUp.asked === undefined;
  try {
    const state = unsent === null ? routeState(b, j, said, lastReply) : { ...(routeState(b, j, said, lastReply) as { [key: string]: JsonValue }), unsentRequest: unsentAbout(t, unsent) };
    const questions = { ...routeQuestions(b, j, t.st.caller, lastReply), ...(unsent === null ? {} : NO_LONGER_WANTS), ...(wrapUp ? WRAPPING_UP : {}) };
    const asked = await askWithinWhy(t.deps.jev, state, questions, b.routing.timeoutMs);
    const ms = Date.now() - started;
    const reading = readRoute(asked.answers);
    const route = decideRoute(b, j, reading, openJourneys(b, t.st.caller), { answersReadBack: t.answersReadBack === true });
    return {
      ...(unsent === null ? {} : { noLongerWants: { action: unsent, reading: probabilityOf(asked.answers?.noLongerWants) } }),
      ...(wrapUp ? { wrappingUp: probabilityOf(asked.answers?.wrappingUp) } : {}),
      next: route.next,
      route: {
        from: j.active,
        to: route.next.active,
        outcome: route.outcome,
        task: reading.task,
        ...(reading.drops !== null ? { drops: reading.drops } : {}),
        ...(reading.again !== null ? { again: reading.again } : {}),
        ...(reading.fits !== null ? { fits: reading.fits } : {}),
        ...(reading.answers !== null ? { answers: reading.answers } : {}),
        ms,
        ...(asked.answers === null && asked.why === 'late' ? { timedOut: true as const } : {}),
        ...(route.droppedPaused !== undefined ? { droppedPaused: route.droppedPaused } : {}),
        ...(isUnclear(route) ? { unclear: route.next.unclear ?? 1 } : {}),
      },
    };
  } catch {
    // Whatever throws here (an answer in no shape the code can read, a client that breaks): the journey as it was.
    return { ...(unsent === null ? {} : { noLongerWants: { action: unsent, reading: null } }), ...(wrapUp ? { wrappingUp: null } : {}), next: j, route: { from: j.active, to: j.active, outcome: 'carry', task: null, ms: Date.now() - started } };
  }
}

/**
 * Whether a part of a message on the caller's side holds the caller's own words: their text (never the check
 * after speaking's note), or the result of a read-back they answered, which carries what they said.
 */
const callersOwn = (c: ModelContent): boolean =>
  (c.type === 'text' && !c.text.startsWith(CHECK_NOTE_MARK)) || (c.type === 'tool_result' && (c.content.startsWith(READ_BACK_ANSWER) || c.content.startsWith(READ_BACK_ANSWER_BEFORE)));

/**
 * What the caller heard of the line's last reply, written into the conversation before their words: the last
 * text of the line's since the caller's last words (its tool calls kept; none there, nothing changes) becomes what they heard with CUT_IN_NOTE after it where they cut in
 * and heard some of it, and UNHEARD_NOTE where they heard none of it (they spoke before it, or cut in before a
 * word of it played); otherwise it stands. A read-back waiting for its answer is not in the conversation:
 * whether it was heard is readBackHeard's, on the answer.
 */
function applyHeard(st: ConverseState, heard: Heard): void {
  if (st.pending !== null || (!heard.cutIn && !heard.spokeBefore)) return;
  // Only the last turn's replies, after the caller's last words: a turn that said nothing leaves an earlier reply as it was heard.
  for (let m = st.messages.length - 1; m >= 0; m--) {
    const msg = st.messages[m]!;
    if (msg.role === 'user' && msg.content.some(callersOwn)) return;
    if (msg.role !== 'assistant') continue;
    let at = msg.content.length - 1;
    while (at >= 0 && msg.content[at]!.type !== 'text') at--;
    if (at < 0) continue;
    const part = heard.text ?? '';
    msg.content[at] = { type: 'text', text: heard.cutIn && part.trim() !== '' ? `${part}${CUT_IN_NOTE}` : UNHEARD_NOTE };
    return;
  }
}

/**
 * One turn of the call. `signal`, where the channel gives one, stops the turn from outside (the caller spoke
 * on a call): the model's request is aborted at once, what was not yet said is dropped, a call already
 * running finishes and keeps its result, and no model round starts after it; the turn counts no failure,
 * says no recovery line and does not end the call, and the state keeps what was said (the trace's
 * `interrupted`). An abort after the turn has ended changes nothing.
 */
export async function converseTurn(s: ConverseState, input: Input, deps: ConverseDeps, out: Out, signal?: AbortSignal): Promise<ConverseState> {
  if (s.ended !== undefined) return s;
  const st = structuredClone(s);
  const now = deps.now();
  const t: Turn = {
    st,
    deps,
    out,
    t0: Date.now(),
    todayIso: localDateIso(now.getTime(), businessZone(deps.business)),
    replies: [],
    tools: [],
    model: { id: deps.model.id, ms: 0, firstTextMs: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null },
    masked: [],
    confirmedRan: false,
    ending: false,
    own: [],
    correcting: false,
    carriedNote: false,
    carriedNoteDropped: false,
    said: input.kind === 'text' ? input.text : null,
    ...(signal !== undefined ? { signal } : {}),
    bridged: false,
    roundSpoke: false,
    roundHeld: false,
    unsentEnds: 0,
  };
  const sp = new Speaker(t);
  // The bridge: on a call, where the channel can say one, once if nothing of a caller turn's reply is said by its wait (bridgeAfterMs).
  const bridge = out.bridge;
  // Not on a silence turn: after nine seconds of quiet, "One sec." reads oddly; the model's own short reply follows.
  if (input.kind === 'text' && st.channel === 'voice' && bridge !== undefined && signal?.aborted !== true) {
    t.bridgeTimer = setTimeout(() => {
      delete t.bridgeTimer;
      if (cut(t)) return;
      t.bridged = true;
      bridge.call(out, lineFor(t, deps.business.lines.bridge));
    }, deps.bridgeAfterMs ?? BRIDGE_AFTER_MS);
  }
  const onAbort = (): void => clearBridge(t);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const after = await turnBody(t, sp, input, now);
    return t.unsaid === true ? s : after;
  } catch (e) {
    let record: ConverseTraceRecord | null = null;
    try {
      record = { ...traceRecordOf(t, input, now).record, failed: 'internal' };
    } catch {
      record = null;
    }
    throw new ConverseTurnError(reached(t), e, record);
  } finally {
    clearBridge(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A turn that threw: `cause` is what it threw, and `state` the call's state as far as the turn reached (reached).
 * A channel keeps that state where a change the caller confirmed ran in the turn (its `done` grew), so the change
 * is never read back or answered again, and moves its turnIndex on past the turn; else it keeps the state from
 * before the turn. `record` is the turn's trace record as far as it reached (`failed: 'internal'`; null where it
 * could not be made): the channel writes it, with the line it says after the throw among its replies, so the turn
 * is in the console as it is in the audit. It holds nothing of what was thrown.
 */
export class ConverseTurnError extends Error {
  constructor(
    readonly state: ConverseState,
    readonly cause: unknown,
    readonly record: ConverseTraceRecord | null = null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ConverseTurnError';
  }
}

/**
 * The turn's state as far as it reached when it threw, made whole for the next request: a read-back set this turn
 * and never said waits for no answer, and every call of the line's with no result has one saying the line failed
 * before it was kept (a read-back said and waiting is the one call that may wait for its answer).
 */
function reached(t: Turn): ConverseState {
  const st = structuredClone(t.st);
  if (st.pending !== null && t.readBackSaid !== true) {
    add(st, 'user', [{ type: 'tool_result', id: st.pending.id, content: 'Not read back: something failed before it was read back, so nothing was done. Call it again to have it read back.', isError: true }]);
    st.pending = null;
  }
  const answered = new Set(st.messages.flatMap((m) => m.content.flatMap((c) => (c.type === 'tool_result' ? [c.id] : []))));
  const open = st.messages.flatMap((m) => m.content.flatMap((c) => (c.type === 'tool_call' && !answered.has(c.id) && c.id !== st.pending?.id ? [c.id] : [])));
  add(st, 'user', open.map((id) => ({ type: 'tool_result' as const, id, content: 'The line failed before this call\'s result was kept: what has been done on this call is in the line\'s own record of it.', isError: true })));
  return st;
}

/**
 * The turn's trace record as far as it has come, with the scrub its replies were masked by: every value of the
 * turn's calls that is recorded masked, masked in what the line said too.
 */
function traceRecordOf(t: Turn, input: Input, now: Date): { record: ConverseTraceRecord; scrubbed: (text: string) => string } {
  const { st, deps } = t;
  // Stopped from outside before it ended (an abort after the turn ended changes nothing).
  const interruptedNow = cut(t);
  const openNow = openAt(deps.business, now.getTime());
  const scrub = scrubberOfValues(t.masked);
  const scrubbed = (text: string): string => (scrub === null ? text : scrub(text));
  const record: ConverseTraceRecord = {
    v: 3,
    kind: 'converse',
    sessionId: st.callId,
    turnIndex: st.turnIndex,
    ts: now.toISOString(),
    said: input.kind === 'text' ? input.text : null,
    replies: t.replies.map(scrubbed),
    tools: t.tools,
    model: { ...t.model, costUsd: input.kind === 'text' || input.kind === 'silence' ? costUsd(deps.model.id, t.model.usage) : null },
    ...(input.kind === 'silence' ? { silence: input.count, silenceMs: input.ms } : {}),
    ...(t.readBack !== undefined ? { readBack: { ...t.readBack, text: scrubbed(t.readBack.text) } } : {}),
    ...(t.check !== undefined ? { check: t.check } : {}),
    ...(t.carriedNote ? { carriedNote: true as const } : {}),
    ...(t.carriedNoteDropped ? { carriedNoteDropped: true as const } : {}),
    ...(t.route !== undefined ? { route: t.route } : {}),
    ...(t.journeyEnded !== undefined ? { journeyEnded: t.journeyEnded } : {}),
    ...(t.unsent !== undefined ? { unsent: t.unsent } : {}),
    ...(t.wrapUp !== undefined ? { wrapUp: { reading: t.wrapUp.known ? t.wrapUp.reading : null, ...(t.wrapUp.held === true ? { held: true as const } : {}), ...(t.wrapUp.dropped !== undefined ? { dropped: { chars: t.wrapUp.dropped } } : {}) } } : {}),
    ...(t.ended !== undefined ? { ended: t.ended } : {}),
    ...(openNow !== undefined ? { open: openNow } : {}),
    ...(interruptedNow ? { interrupted: true as const } : {}),
    ...(t.bridged ? { bridge: true as const } : {}),
    ...(input.kind !== 'start' && input.ignored !== undefined && input.ignored.length > 0 ? { ignored: [...input.ignored] } : {}),
    ...(input.kind === 'text' && input.heard !== undefined ? { heard: { cutIn: input.heard.cutIn, spokeBefore: input.heard.spokeBefore, chars: input.heard.text === null ? null : input.heard.text.length } } : {}),
  };
  return { record, scrubbed };
}

/** A line the channel said itself after a turn threw, kept in the conversation as the line's. */
export function lineSaid(st: ConverseState, text: string): void {
  add(st, 'assistant', [{ type: 'text', text }]);
}

/**
 * What the model is told of a silence, in the conversation where it learns what the caller said: context and the goal
 * (help the caller go on, as a person would), never words for it to say.
 */
export const silenceNote = (ms: number, readBackLetGo = false): string =>
  `[The caller has said nothing for ${Math.round(ms / 1000)} seconds since your last reply${readBackLetGo ? '; the read-back no longer waits for their answer, so their yes needs the action called again' : ''}. Help them go on, as a person on the phone would when the other side goes quiet, in a short reply.]`;

/**
 * A silence of the caller's on a call (agent.yaml's `silence`). A silence is no answer: a read-back waiting for the yes
 * goes on waiting (its call is given a result that says so, the first time, so the model can be asked), nothing is
 * counted and nothing let go, and a yes that comes after it still confirms it. Either the model answers the silence,
 * told of it (silenceNote), a failure saying lines.silence where the app has it; or, the last one (`end`), the line says
 * lines.silenceEnd (the closing line where it has none) before anything else, and ends the call as end_call ends it. A
 * turn stopped before the goodbye is said ends nothing. The end is the line's own decision, not the model's: a change
 * kept unsent (or a read-back waiting) does not keep the call open (the unclear end and the handoff do the same), and
 * the trace records it.
 */
async function silenceTurn(t: Turn, sp: Speaker, input: Extract<Input, { kind: 'silence' }>): Promise<void> {
  const { st, deps } = t;
  t.silence = input.count;
  if (cut(t)) return;
  const p = st.pending;
  if (input.end) {
    // The goodbye first, before anything is awaited: once it is said, the end stands.
    const line = lineFor(t, deps.business.lines.silenceEnd ?? deps.business.lines.closing);
    sp.line(line);
    st.pending = null;
    if (st.unsent !== undefined) t.unsent = { action: st.unsent.action };
    else if (p !== null) t.unsent = { action: p.action };
    if (p !== null) add(st, 'user', [{ type: 'tool_result', id: p.id, content: `${READ_BACK_ANSWER}${p.text}" Not done: nothing was changed, booked or sent. The caller said nothing after it, and the call ended.` }]);
    add(st, 'assistant', [{ type: 'text', text: line }]);
    t.ended = 'silence';
    st.ended = 'closing';
    t.out.end('closing');
    await record(t, { type: 'converse_end', detail: { by: 'silence', ...(p !== null ? { pending: p.action } : {}) } });
    return;
  }
  // A read-back waiting is let go: the line's words now follow it, so a yes would be to them (a silence turn stopped
  // before it says anything changes nothing: the channel keeps the state from before it). Not confirmed, no refusal
  // counted, not marked unheard, and kept unsent. Nor kept as the one heard: a caller silent after it may not have been
  // listening, so a correction then is read back whole, never by its changed values alone.
  if (p !== null) {
    st.pending = null;
    const spec = Object.hasOwn(deps.business.actions, p.action) ? deps.business.actions[p.action] : undefined;
    t.readBack = { text: p.text, ...changesOf(p), confirmed: false };
    traceTool(t, spec, p.action, p.params, 'notConfirmed', 'the caller said nothing');
    keepUnsent(t, p);
    if (st.heardReadBack?.action === p.action) delete st.heardReadBack;
    add(st, 'user', [{ type: 'tool_result', id: p.id, content: `Read back to the caller as said: "${p.text}" Not done: nothing was changed, booked or sent. The caller said nothing after it.` }]);
  }
  add(st, 'user', [{ type: 'text', text: silenceNote(input.ms, p !== null) }]);
  await converse(t, sp);
}

/** The turn's work once its clock, speaker and bridge are set up: converseTurn's, which clears the bridge after it. */
async function turnBody(t: Turn, sp: Speaker, input: Input, now: Date): Promise<ConverseState> {
  const { st, deps, out } = t;
  // A read-back not heard kept for an action the business no longer has (a state saved before it changed) is let go.
  for (const action of Object.keys(st.unheardReadBacks ?? {})) if (!Object.hasOwn(deps.business.actions, action)) letGoUnheard(t, action);
  if (input.kind === 'start') {
    if (hasJourneys(deps.business)) {
      st.journey = initialJourney(deps.business, st.caller);
      // A call that starts in a journey (its `start`) has it on record from the start turn: nothing was asked.
      if (st.journey.active !== null) t.route = { from: null, to: st.journey.active, outcome: 'start', task: null, ms: 0 };
    }
    // A call started in a journey (its `start`) with a greeting of its own opens with it, in place of the business's.
    const started = st.journey?.active ? deps.business.journeys?.[st.journey.active] : undefined;
    // A business that is closed as the call starts (business.open) says its after-hours greeting first of all: a journey's greeting may speak of today.
    const closedGreeting = openAt(deps.business, now.getTime()) === false ? deps.business.lines.greetingAfterHours : undefined;
    const greeting = lineFor(t, closedGreeting ?? started?.greeting ?? deps.business.lines.greeting);
    sp.line(greeting);
    add(st, 'assistant', [{ type: 'text', text: greeting }]);
  } else if (input.kind === 'silence') {
    await silenceTurn(t, sp, input);
  } else if (input.kind === 'left') {
    // The caller left: a read-back waiting for an answer is dropped, and nothing runs.
    const pending = st.pending?.action ?? null;
    st.pending = null;
    // A note carried for the model is dropped with the call.
    delete st.carriedNote;
    st.ended = 'left';
    await record(t, { type: 'converse_left', detail: { pending } });
  } else {
    const routed = hasJourneys(deps.business);
    // A state saved before journeys starts where its call would have.
    if (routed) st.journey ??= initialJourney(deps.business, st.caller);
    // What the caller heard of the last reply, before their words (and before routing reads that reply).
    if (input.heard !== undefined) applyHeard(st, input.heard);
    const lastReply = routed ? lastReplyOf(st) : null;
    // A change could be left unsent this turn (one kept unsent, or a read-back waiting whose answer may keep it): whether the
    // caller is wrapping up the call is read, in the routing request where there is one, so a goodbye written with an
    // end_call the unsent rule refuses is held and never said (holdsWords).
    if (st.pending !== null || st.unsent !== undefined) t.wrapUp = { reading: null, known: false };
    if (!routed && t.wrapUp !== undefined) {
      // No routing request this turn to ask in: asked on its own, alongside the read-back's reading and the model. With a
      // change kept unsent (and no read-back waiting), the same request asks whether the caller no longer wants it, read
      // where an end_call depends on it (settleWithdrawal); late or failed, nothing changes.
      const withdrawal = st.pending === null && st.unsent !== undefined ? st.unsent.action : null;
      const state = { said: input.text, lastReply: lastReplyOf(st), ...(withdrawal !== null ? { unsentRequest: unsentAbout(t, withdrawal) } : {}) };
      const asked = askWithin(deps.jev, state, { ...(withdrawal !== null ? NO_LONGER_WANTS : {}), ...WRAPPING_UP }, deps.jevTimeoutMs);
      if (withdrawal !== null) t.withdrawal = { action: withdrawal, reading: asked.then((a) => probabilityOf(a?.noLongerWants)), settled: false };
      t.wrapUp.asked = asked.then((a) => wrapUpRead(t, probabilityOf(a?.wrappingUp)));
    }
    let answer: ReadBackAnswer | null = null;
    if (st.pending !== null) {
      t.answersReadBack = true;
      answer = await answered(t, sp, input.text, input.heard);
    } else add(st, 'user', [{ type: 'text', text: neutralised(input.text) }]);
    // A no the line answered with lines.notConfirmed is the turn's reply: nothing is routed or asked, and a carried
    // note waits for the next message the model is sent.
    if (answer !== 'asked') {
      // A yes that ran its action is not routed: the caller answered the read-back, and the journey moved on by it.
      // Any other answer to a read-back is routed on the same words, alongside the model's first round.
      const routing = routed && answer !== 'ran' ? routeOf(t, st.journey!, input.text, lastReply) : undefined;
      if (routed && routing === undefined && t.wrapUp !== undefined) {
        // A yes that ran is not routed: where a change is still kept unsent (another action's), whether the caller is
        // wrapping up is asked on its own; else nothing could be left unsent, and it is not asked.
        if (st.unsent !== undefined) {
          const w = t.wrapUp;
          w.asked = askWithin(deps.jev, { said: input.text, lastReply }, WRAPPING_UP, deps.jevTimeoutMs).then((a) => wrapUpRead(t, probabilityOf(a?.wrappingUp)));
        } else delete t.wrapUp;
      }
      const carried = st.carriedNote;
      if (carried !== undefined) {
        // The check after speaking's note carried from a turn that ended on a read-back: after this message's
        // own content (the caller's words, or what came of the read-back), in the same message, never neutralised.
        add(st, 'user', [{ type: 'text', text: carried }]);
        delete st.carriedNote;
        t.carriedNote = true;
      }
      await converse(t, sp, false, carried, routing);
      // A reply the caller cut in on is not read: they did not hear it through, and the next turn answers them.
      if (!cut(t)) await checkAfterSpeaking(t, sp);
    } else if (routed) delete t.wrapUp;
    await settleWithdrawal(t);
    // The reading asked on its own is in the turn's record, waited for (it is in by the decision model's time) only where
    // the model was asked and the turn was not stopped; else the record has it as it stands.
    if (answer !== 'asked' && !cut(t)) await t.wrapUp?.asked;
  }
  // A turn on a silence stopped before it said anything (the caller spoke first) is as if it never ran: no record, and
  // the state as it was (converseTurn returns it).
  if (input.kind === 'silence' && cut(t) && t.replies.length === 0) {
    t.unsaid = true;
    return st;
  }
  const traced = traceRecordOf(t, input, now);
  out.scrubbed?.(traced.scrubbed);
  deps.trace(traced.record);
  st.turnIndex += 1;
  return st;
}

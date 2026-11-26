import { isNoul, type Answer, type AnswerMap, type JevClient, type JsonValue, type QuestionMap } from '../jev/types';
import { resultId, type Seen } from './actions';
import { CHANGES, type AgentBusiness, type Lang, type ParamSpec } from './business/schema';

/**
 * Confirmation of a change (docs/designs/2026-11-11-agent-runtime.md, "Tools, the gate and
 * confirmation"): the runtime says the business's read-back, filled with exactly the call's params as
 * each type displays them, and the decision model reads the caller's answer as a yes and a no. Only a
 * clear yes with no no confirms (isConfirmed); anything else goes back to the model as not confirmed.
 */

/** A change read back and waiting for the caller's answer: its params, their confirmation hash, the words said, and the model's call id. */
export interface PendingReadBack {
  action: string;
  params: Record<string, string>;
  hash: string;
  text: string;
  id: string;
  /** On a short read-back (readBackChange), the params it said, the ones changed. Absent: the full read-back was said. */
  changes?: string[];
}

/** The locale each language's dates are said in. */
const DATE_LOCALE: Record<Lang, string> = { en: 'en-US' };

/** A day as it is said: "Friday, November 13". A value that is no day is said as it is. */
function dayShown(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(DATE_LOCALE[lang], { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}

/** A slot as it is said: its label among the lookup's results, else the label of the calendar window it names, else its id. */
function slotShown(b: AgentBusiness, spec: ParamSpec, id: string, seen: Seen): string {
  const from = spec.from ?? '';
  const result = Object.hasOwn(seen, from) ? seen[from]!.results.find((r) => resultId(r) === id) : undefined;
  const label = typeof result === 'object' && result !== null ? (result as { label?: unknown }).label : undefined;
  if (typeof label === 'string' && label.trim() !== '') return label;
  return b.sources.calendar?.windows.find((w) => w.name === id)?.label ?? id;
}

/**
 * A phone number as it is read back: the number the caller is calling from as that, by its last four (they
 * did not say it, and it is never said whole); any other, the one they gave, whole, a North American number
 * in groups ("555 555 0142"), another as it was checked (E.164).
 */
function phoneShown(value: string, callerNumber: string | undefined): string {
  const digits = value.replace(/\D/g, '');
  if (callerNumber !== undefined && callerNumber.replace(/\D/g, '') === digits) return `the number you're calling from, ending in ${digits.slice(-4)}`;
  const ten = value.startsWith('+1') && digits.length === 11 ? digits.slice(1) : null;
  return ten === null ? value : `${ten.slice(0, 3)} ${ten.slice(3, 6)} ${ten.slice(6)}`;
}

/** The business's day as a person says it, with its year: "Wednesday, November 11, 2026". A value that is no day is said as it is. */
export function dayInWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}

/** A param's value as its type displays it: a date as its day, a slot by its label, a phone as phoneShown. */
function shown(b: AgentBusiness, spec: ParamSpec | undefined, value: string, lang: Lang, seen: Seen, callerNumber: string | undefined): string {
  if (value === '' || spec === undefined) return value;
  switch (spec.type) {
    case 'date': return dayShown(value, lang);
    case 'slot': return slotShown(b, spec, value, seen);
    case 'phone': return phoneShown(value, callerNumber);
    default: return value;
  }
}

/**
 * The read-back of `action` in `lang`, each {placeholder} filled with its param as the type displays
 * it. A part in square brackets is said only when every param it names has a value, without its brackets
 * ("for the {item}[, {details}]"): that is where an optional param is read back. `seen` holds the lookups' results a slot's label is read
 * from (required, so a caller never reads a slot back without this call's lookups). Throws for an action with no read-back: only a change has one, and agent.yaml's check makes
 * every change have one.
 */
export function readBackText(b: AgentBusiness, action: string, params: Record<string, string>, lang: Lang, seen: Seen, callerNumber?: string): string {
  const spec = b.actions[action];
  const frame = spec?.readBack?.[lang];
  if (spec === undefined || frame === undefined) throw new Error(`"${action}" has no read-back in ${lang}`);
  const given = (name: string): boolean => (params[name] ?? '') !== '';
  const parts = frame.replace(/\[([^[\]]*)\]/g, (_, part: string) => ([...part.matchAll(/\{([^{}]*)\}/g)].every((m) => given(m[1]!)) ? part : ''));
  return parts.replace(/\{([^{}]*)\}/g, (_, name: string) => shown(b, spec.params[name], params[name] ?? '', lang, seen, callerNumber));
}

/**
 * The params of `action` that a short read-back (agent.yaml's readBackChange) would say for `params`, after the
 * caller heard `before` read back and did not confirm it: those whose value differs from it, in the action's param
 * order. Null where the full read-back is said instead: the action has no short read-back, no value differs (the
 * caller asked to hear it all), or a param that differs has no phrase or no value now (one cleared is read in full).
 */
export function changedParams(b: AgentBusiness, action: string, params: Readonly<Record<string, string>>, before: Readonly<Record<string, string>>, lang: Lang): string[] | null {
  const spec = Object.hasOwn(b.actions, action) ? b.actions[action] : undefined;
  const short = spec?.readBackChange?.[lang];
  if (spec === undefined || short === undefined) return null;
  const changed = Object.keys(spec.params).filter((k) => (params[k] ?? '') !== (before[k] ?? ''));
  if (changed.length === 0) return null;
  return changed.every((k) => Object.hasOwn(short.params, k) && (params[k] ?? '') !== '') ? changed : null;
}

/**
 * The short read-back of `action` in `lang` (agent.yaml's readBackChange): its frame with {changes} the phrase of
 * each of `changes`, in that order, each value shown as the full read-back shows it (a date as its day, a slot by
 * its label, a phone as phoneShown), joined by commas and, where the frame gives its word (`and`), the last two by
 * it. Throws for an action with no short read-back.
 */
export function shortReadBackText(b: AgentBusiness, action: string, params: Record<string, string>, changes: readonly string[], lang: Lang, seen: Seen, callerNumber?: string): string {
  const spec = b.actions[action];
  const short = spec?.readBackChange?.[lang];
  if (spec === undefined || short === undefined) throw new Error(`"${action}" has no short read-back in ${lang}`);
  const phrases = changes.map((k) => (short.params[k] ?? '').replace(/\{([^{}]*)\}/g, (_, name: string) => shown(b, spec.params[name], params[name] ?? '', lang, seen, callerNumber)));
  const joined = short.and !== undefined && phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} ${short.and} ${phrases.at(-1)!}` : phrases.join(', ');
  return short.say.replace(`{${CHANGES}}`, () => joined);
}

/** Each param of `action` as its read-back says it (a date as its day, a slot by its label, a phone as phoneShown), for the trace to mask where it is said. */
export function shownParams(b: AgentBusiness, action: string, params: Record<string, string>, lang: Lang, seen: Seen, callerNumber?: string): Record<string, string> {
  const spec = Object.hasOwn(b.actions, action) ? b.actions[action] : undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = shown(b, spec?.params[k], v, lang, seen, callerNumber);
  return out;
}

/** At or above this, the caller's answer reads as a yes. */
export const CONFIRM_YES_AT = 0.7;
/** Below this, it does not read as a no as well. */
export const CONFIRM_NO_BELOW = 0.3;

/** Whether the reading is a yes: a clear yes and no no ("yeah, but make it four" reads both, and is not). No reading is no yes. */
export function isConfirmed(r: { yes: number; no: number } | null): boolean {
  return r !== null && r.yes >= CONFIRM_YES_AT && r.no < CONFIRM_NO_BELOW;
}

/**
 * At or above this, the caller's answer reads as a clear no: the bar a yes is held to (CONFIRM_YES_AT), so the
 * business's fixed line for a no (lines.notConfirmed) answers only a no as clear as a yes must be to run anything.
 */
export const DECLINED_AT = CONFIRM_YES_AT;
/**
 * Below this, the answer says nothing of what should be different: the bar a no must stay under for a yes to
 * count (CONFIRM_NO_BELOW), so an answer that may hold a correction at all goes to the model, which can take
 * it, rather than to the fixed line, which would ask for what the caller has just given.
 */
export const CHANGE_BELOW = CONFIRM_NO_BELOW;

/**
 * Whether the reading is a clear no that says nothing of what should be different (a bare "no", "that's not
 * right"): not a yes, a no at DECLINED_AT or above, and the change read below CHANGE_BELOW. A reading with no
 * change read, or no reading, is not.
 */
export function isDeclinedWithoutChange(r: ReadBackReading | null): boolean {
  return r !== null && !isConfirmed(r) && r.no >= DECLINED_AT && r.change !== undefined && r.change < CHANGE_BELOW;
}

/**
 * At or above this, the caller withdraws what was read back (they want none of it): the bar a yes is held to
 * (CONFIRM_YES_AT), since a withdrawal lets go of the guard that keeps a change from being left unsent unasked,
 * and that needs a reading as clear as running one does.
 */
export const WITHDRAWN_AT = CONFIRM_YES_AT;

/** Whether the reading is a clear withdrawal: not a yes, and `withdraws` read at WITHDRAWN_AT or above. No reading, or none of it, is not. */
export function isWithdrawn(r: ReadBackReading | null): boolean {
  return r !== null && !isConfirmed(r) && r.withdraws !== undefined && r.withdraws >= WITHDRAWN_AT;
}

/** The decision model's reading of the caller's answer to a read-back: a yes, a no, and (where each was read) whether they say what should be different and whether they withdraw it. */
export interface ReadBackReading {
  yes: number;
  no: number;
  /** Whether the caller says what should be different (a change, a correction or a new detail). Absent: not read. */
  change?: number;
  /** Whether the caller withdraws what was read back, wanting none of it. Absent: not read. */
  withdraws?: number;
}

/**
 * The questions of the scripted mode's confirmation (core/questions.ts `confirmation`, with its neutral
 * confirmsNo wording), copied, not imported, so the converse runtime stays off the scripted engine; the
 * state they read is the read-back and what the caller said. And the converse runtime's own, asked in the
 * same request: whether the caller says what should be different, so a bare no can be met with the
 * business's line for it (lines.notConfirmed) and a correction left to the model; and whether they withdraw
 * it, so a change they no longer want is neither asked about by that line nor kept unsent.
 */
const YES_NO: QuestionMap = {
  confirmsYes: {
    type: 'noul',
    instructions: 'Read said and readBack. Does the caller answer yes to the confirmation question?',
  },
  confirmsNo: {
    type: 'noul',
    instructions: 'Read said and readBack. Does the caller answer no to the confirmation question?',
    criteria: {
      true: 'The caller says no, says something is wrong, or gives a value that replaces or contradicts a detail the system just read back, including a bare correction such as "not the twelfth, the thirteenth" or "Saturday, not Friday", whether or not the system itself named the value they reject',
      false: 'The caller agrees, answers something else, or says nothing about the question',
    },
  },
  saysChange: {
    type: 'noul',
    instructions: 'Read said and readBack. Does the caller say what should be different from what was read back?',
    criteria: {
      true: 'The caller gives a change, a correction or a new detail: a value that replaces or adds to what was read back, or what they want instead',
      false: 'The caller only agrees or declines, asks something, or says nothing of what should be different',
    },
  },
  withdraws: {
    type: 'noul',
    instructions: 'Read said and readBack. Does the caller withdraw what was read back, wanting none of it at all, as opposed to wanting something in it changed?',
    criteria: {
      true: 'The caller does not want it at all: they cancel it, say never mind or forget it, or say they no longer need it',
      false: 'The caller agrees, wants something in it changed or added, asks something, or says nothing of whether they still want it',
    },
  },
};

/**
 * The question asked on a caller turn while a change the caller did not confirm is kept unsent (ConverseState.unsent):
 * whether they say they no longer want it. Its state is what the caller said, the line's last words before them, and
 * what the change is for in the business's own words (`unsentRequest`: its action's `about`, never its values).
 */
export const NO_LONGER_WANTS: QuestionMap = {
  noLongerWants: {
    type: 'noul',
    instructions: 'Read said, with lastReply for context, and unsentRequest. Does the caller say they no longer want unsentRequest at all?',
    criteria: {
      true: 'The caller withdraws it: they cancel it, say never mind or forget it, or say they no longer need it',
      false: 'The caller wants it, wants something in it changed, talks of something else, or says nothing of whether they still want it',
    },
  },
};

const isProbability = (n: number): boolean => Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * One request to the decision model, aborted once `timeoutMs` have passed: its answers, or null when the
 * model errs or has not answered in time. It never throws. The converse runtime's readings use it: the
 * caller's answer to a read-back (readYesNo) and the check after speaking (claims.ts readClaims).
 */
export async function askWithin(jev: JevClient, state: JsonValue, questions: QuestionMap, timeoutMs: number): Promise<AnswerMap | null> {
  return (await askWithinWhy(jev, state, questions, timeoutMs)).answers;
}

/**
 * askWithin, with why it returned no answers where it did not: `late` when `timeoutMs` passed first (the
 * request is then aborted), `error` when the model erred first. It never throws. Routing uses it, to tell a
 * decision model that was late from one that failed (the route's `timedOut`).
 */
export async function askWithinWhy(jev: JevClient, state: JsonValue, questions: QuestionMap, timeoutMs: number): Promise<{ answers: AnswerMap } | { answers: null; why: 'late' | 'error' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const asked = Promise.resolve().then(() => jev.ask({ state, questions, timeoutMs, signal: controller.signal }));
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('late');
      }, timeoutMs);
    });
    const res = await Promise.race([asked, late]);
    return res === 'late' ? { answers: null, why: 'late' } : { answers: res.answers };
  } catch {
    return { answers: null, why: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** A noul answer's probability, or null where the answer is missing, of another type, or not a probability. */
export function probabilityOf(a: Answer | undefined): number | null {
  return a !== undefined && isNoul(a) && isProbability(a.noul) ? a.noul : null;
}

/**
 * The decision model's reading of what the caller said to the read-back, in one request: how much it
 * reads as a yes and as a no, whether it says what should be different (`change`) and whether it withdraws
 * what was read back (`withdraws`), each absent where its answer is missing or no probability (the yes and
 * the no stand without them). `today`, the business's day in words (dayInWords), is in its state where
 * given, so an answer that names a day ("tomorrow", "Thursday") is read against the day the read-back
 * says rather than as a value that replaces it. Null when the model errs, gives no answer to either, or
 * has not answered within `timeoutMs` (the request is then aborted). It never throws.
 */
export async function readYesNo(jev: JevClient, readBack: string, said: string, timeoutMs: number, today?: string): Promise<ReadBackReading | null> {
  const answers = await askWithin(jev, { readBack, said, ...(today !== undefined ? { today } : {}) }, YES_NO, timeoutMs);
  if (answers === null) return null;
  const yes = probabilityOf(answers.confirmsYes);
  const no = probabilityOf(answers.confirmsNo);
  const change = probabilityOf(answers.saysChange);
  const withdraws = probabilityOf(answers.withdraws);
  return yes === null || no === null ? null : { yes, no, ...(change !== null ? { change } : {}), ...(withdraws !== null ? { withdraws } : {}) };
}

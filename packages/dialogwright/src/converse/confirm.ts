import { isNoul, type Answer, type AnswerMap, type JevClient, type JsonValue, type QuestionMap } from '../jev/types';
import { resultId, type Seen } from './actions';
import type { AgentBusiness, Lang, ParamSpec } from './business/schema';

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
 * The questions of the scripted mode's confirmation (core/questions.ts `confirmation`, with its neutral
 * confirmsNo wording), copied, not imported, so the converse runtime stays off the scripted engine; the
 * state they read is the read-back and what the caller said.
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
 * reads as a yes and as a no. `today`, the business's day in words (dayInWords), is in its state where
 * given, so an answer that names a day ("tomorrow", "Thursday") is read against the day the read-back
 * says rather than as a value that replaces it. Null when the model errs, gives no answer to either, or
 * has not answered within `timeoutMs` (the request is then aborted). It never throws.
 */
export async function readYesNo(jev: JevClient, readBack: string, said: string, timeoutMs: number, today?: string): Promise<{ yes: number; no: number } | null> {
  const answers = await askWithin(jev, { readBack, said, ...(today !== undefined ? { today } : {}) }, YES_NO, timeoutMs);
  if (answers === null) return null;
  const yes = probabilityOf(answers.confirmsYes);
  const no = probabilityOf(answers.confirmsNo);
  return yes === null || no === null ? null : { yes, no };
}

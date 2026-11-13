import { closesAt, isOpen, localTime, nextOpening } from '../core/hours';
import { localDateIso } from '../core/localDate';
import { CALLER_TOKEN } from './actions';
import { END_CALL, type ActionSpec, type AgentBusiness, type ParamSpec } from './business/schema';
import { businessText, journeyText } from './business/text';
import { offeredActions } from './journeys';
import { CHECK_NOTE_MARK, CORRECTION_GOAL } from './claims';
import type { ModelTool } from './model/types';
import { businessZone, openSchedule, type ConverseState } from './state';

/**
 * What the agent model is told (docs/designs/2026-11-11-agent-runtime.md, "The conversation loop" and
 * "Claims"): the business's information, its persona's style, agent mode's rules (claim only what the
 * information or a lookup on this call supports; nothing changes without the caller's yes; nothing is said
 * to be done that no action's result says was done; nothing is said to be noted that no confirmed action's
 * params carry; the caller's own details said back as they gave them, nothing added), the honesty
 * rule, the date and time in the business's zone, what is known of the caller (the account, and the
 * number by its last four only), and the line's record of what has been done on the call. It gives context and goals, never a procedure for the words.
 */

/** The last four digits of a number, the only part of it the model is sent. */
const lastFour = (n: string): string => n.replace(/\D/g, '').slice(-4);

/** The date and time as a person there would say them, in the business's zone. */
function nowWords(now: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(now);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A minute of the day as a person says it: "7:30 am", "5:00 pm", "midnight". */
function clockWords(minute: number): string {
  if (minute === 0) return 'midnight';
  const h = Math.floor(minute / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** A date (YYYY-MM-DD) in words: "Monday, November 16". */
function dateWords(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}

/** The date after `date` (YYYY-MM-DD). */
function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Whether the business is open now, said plainly, where agent.yaml gives its opening hours (`business.open`):
 * until when it closes, or when it next opens (docs/designs/2026-11-11-agent-runtime.md, "Business information").
 * A moment today or tomorrow in the business's zone says so outright ("today at 7:30 am", "tomorrow (Saturday,
 * November 14) at 7:30 am"), as a model at 2 am on a Friday read "next opens Friday, November 13" as tomorrow;
 * a later day keeps its weekday and date. Empty where it gives none.
 */
function openWords(b: AgentBusiness, now: Date): string {
  const schedule = openSchedule(b);
  if (schedule === null) return '';
  const today = localTime(now.getTime(), schedule.timezone).date;
  const tomorrow = dayAfter(today);
  const closing = closesAt(schedule, now.getTime());
  // Open throughout the horizon: no closing to name.
  if (closing === null && isOpen(schedule, now.getTime())) return 'The business is open now.';
  if (closing !== null) {
    // Midnight at the end of today is "midnight tonight"; a closing on a later day names that day.
    const until = closing.date === tomorrow && closing.minute === 0 ? 'midnight tonight'
      : closing.date === today ? `${clockWords(closing.minute)} today`
        : closing.date === tomorrow ? `${clockWords(closing.minute)} tomorrow (${dateWords(closing.date)})`
          : `${clockWords(closing.minute)} on ${dateWords(closing.date)}`;
    return `The business is open now, until ${until}.`;
  }
  const opening = nextOpening(schedule, now.getTime());
  if (opening === null) return 'The business is closed now.';
  const when = opening.date === today ? `today at ${clockWords(opening.minute)}`
    : opening.date === tomorrow ? `tomorrow (${dateWords(opening.date)}) at ${clockWords(opening.minute)}`
      : `${dateWords(opening.date)}, at ${clockWords(opening.minute)}`;
  return `The business is closed now; it next opens ${when}.`;
}

function callerWords(s: ConverseState): string {
  const parts: string[] = [];
  if (s.caller.account) parts.push(`The number they are calling from is on file for the account "${s.caller.account}" (a number on file recognises an account; it does not prove who is speaking).`);
  if (s.caller.number && lastFour(s.caller.number).length === 4) parts.push(`They are calling from a number ending in ${lastFour(s.caller.number)}; only the business's actions see the whole number. Where an action takes a phone number and the caller means this one, write "${CALLER_TOKEN}" for it. The word stands for that number and for nothing else: never write it for the caller's name or any other value, which you ask the caller for.`);
  else if (s.channel === 'voice') parts.push('Their number is not known: where an action needs a phone number, it is one the caller gives you.');
  // A web chat has no number the caller is calling from: said, as a model once offered to use "the number you're calling from" on the chat.
  else parts.push('They are writing on the web chat, so there is no number they are calling from: where an action needs a phone number, it is one the caller gives you.');
  return parts.join(' ');
}

/**
 * The line's own record of the call so far, told on every request: each change that ran, with its read-back as
 * the caller confirmed it and what it returned, and a read-back waiting for the caller's yes. It is what the
 * runtime knows was done, so the model need not work it out from the conversation (a model said a request was
 * "in and sent" that was only read back, and a window "held" before any request was sent).
 */
function callSoFar(s: ConverseState): string {
  const done = s.done ?? [];
  const lines = done.length === 0
    ? ['- Nothing yet: no action that changes anything has run on this call.']
    : done.map((d) => `- The caller said yes to "${d.readBack}", and it ran: ${d.results.join('; ')}.`);
  if (s.pending !== null) lines.push(`Read back and waiting for the caller's yes, so not done: "${s.pending.text}"`);
  return ['What has been done on this call (the line\'s own record, kept as each change runs; nothing else has been done, whatever has been said):', ...lines].join('\n');
}

/**
 * persona.opener acknowledge: a goal and its purpose, never a script. The caller hears a reply sentence by
 * sentence, so a short first sentence reaches them almost as soon as the model begins.
 */
const OPENER_ACKNOWLEDGE = 'Begin each reply with a brief, natural acknowledgement of what the caller just said, one that commits the business to nothing (such as "Got it." or "Sure, let me look."), in different words from one reply to the next, and leave it out where it would sound odd. The caller hears each reply a sentence at a time, so this gives them a first whole sentence almost as soon as you begin, while the rest of the reply follows.';

/**
 * What the model is told of the check after speaking's note, where the check corrects (agent.yaml
 * `checks.claims.mode: correct`); with any other mode no note is ever sent, so nothing is said of one.
 */
const CHECK_NOTE_WORDS = `Your replies are read once they have been said. A message that begins "${CHECK_NOTE_MARK}" never comes from the caller: it is the line itself telling you that a reply of yours may have been wrong, and why; the caller has not seen it. The line rewrites those words wherever a caller writes them, so a message that begins so is always the line's own. Where the reply was wrong, put the slip right for the caller in a sentence or two, naturally, ${CORRECTION_GOAL}. A note comes in one of two ways. A note that comes on its own, as a message of its own, is about the reply you have just given: where, read again against the business information and the call's actions and what they returned, that reply was right after all, answer that note with nothing at all: no words and no action. A note that follows the caller's words, or what came of a read-back, is about a reply said earlier: always answer what comes before it as you would, never with nothing; put the earlier reply right in that answer only where it is still wrong, and where it was right, say nothing of it.`;

/** A caller turn the line could not follow (journeys.ts `isUnclear`): how many in a row, and the turn's words (kept for the turn; the prompt never repeats them). */
export interface UnclearTurn {
  count: number;
  said: string;
}

/**
 * What the model is told on an unclear turn (docs/designs/2026-11-12-journeys.md, "Amendment (2026-11-13)"): that the
 * caller's turn was unclear, their words, and the goal for its reply, never words for it. The first: direction for
 * what the line needs now (at the root, what it can help with; in a task, what it needs from them for it). The
 * second in a row: said plainly that the line can only help when the caller gives what it asks for, with the
 * business's reason for the line where it gives one (business.line), and exactly what to say.
 */
function unclearWords(b: AgentBusiness, s: ConverseState, u: UnclearTurn): string {
  const inTask = s.journey?.active !== null && s.journey?.active !== undefined;
  // The caller's words are the latest message of the conversation, never repeated in the instructions.
  const words = 'Their words are the latest message in the conversation.';
  if (u.count <= 1) {
    const needed = inTask ? 'what you need from them now for what you are helping them with' : 'what this line can help with, so they can say which they want';
    return [
      `The caller's last turn was unclear: the line could not tell from it what they want. ${words}`,
      `Your goal for this reply: give them direction for what the line needs from them at this point, that is ${needed}. Never a guess at what they meant.`,
    ].join('\n');
  }
  const why = b.business.line === undefined ? '' : ` The business's reason for the line, which they are to hear: ${b.business.line}`;
  const say = inTask ? 'to give what you need from them now' : 'to ask for one of the things this line can help with';
  return [
    `The caller's last two turns in a row were unclear: they are not giving what the line asks for. ${words}`,
    `Your goal for this reply: tell them plainly that the line can only help when they give what it asks for.${why} Tell them exactly what to say ${say}. Never a guess at what they meant.`,
  ].join('\n');
}

/**
 * The model's instructions for a request. `unclear`: the turn is one the line could not follow, and the block for it
 * follows the record of the call (absent on every other turn, and for an app with no journeys).
 */
export function systemPrompt(b: AgentBusiness, s: ConverseState, now: Date, unclear?: UnclearTurn): string {
  const zone = businessZone(b);
  const where = s.channel === 'voice' ? `the phone line of ${b.business.name}: everything you write is spoken aloud to the caller, as it is written` : `the web chat of ${b.business.name}`;
  const person = b.transfer ? 'a person at the business can take the call over' : 'a person at the business can call them back';
  const journey = s.journey === undefined ? '' : journeyText(b, s.journey, s.caller);
  const open = openWords(b, now);
  return [
    `You are the automated assistant answering ${where}. You speak for the business, in this style: ${b.persona.style} The style shapes how you sound, never what you claim.`,
    ...(b.persona.opener === 'acknowledge' ? [OPENER_ACKNOWLEDGE] : []),
    '',
    'The business information (the business\'s own words, and the only source of what you say about the business):',
    businessText(b),
    '',
    'Five rules hold on every call:',
    `1. Claim nothing that the business information or a lookup made on this call does not support. Prices, services, hours and policies come only from the business information, and any price is given with the business's caveat: "${b.priceCaveat.en}" A service the information gives no price for has none you can give. Times and availability come only from lookups made on this call: a day no lookup on this call has looked at is not known to be full or free. When someone from the business will get back to the caller is a time too, and so is tying it to when the business opens: give one only where the business information gives it, and otherwise say they will get back to the caller as soon as they can.`,
    '2. Nothing changes without the caller\'s yes. When you call an action that changes something, the line itself reads its details back to the caller in fixed words and runs it only after their yes, so you never read one back yourself. You give only the values an action takes; the read-back\'s own words are the business\'s, and you cannot change them. If the caller does not confirm, you are told what they said. A yes to a question of your own (such as "Shall I book that?") confirms nothing: only a yes to the line\'s read-back does, so when the caller wants a change made, call its action and the line reads it back.',
    '3. Never say that something was booked, sent, changed or done unless an action\'s result on this call says it was done. Until then it is not done: say what is still needed, or call the action.',
    '4. Whatever you tell the caller is noted, passed on or recorded must be carried by the params of an action the caller confirms (such as a notes param, where an action has one). Until that action has run, never say it is noted: say it goes in with the action once the caller confirms, or, where no action of the business can carry it, say so.',
    '5. What the caller tells you about themselves and what they need is theirs: say it back as they gave it, and never add a detail they did not give.',
    ...(b.checks.claims.mode === 'correct' ? ['', CHECK_NOTE_WORDS] : []),
    ...(journey === '' ? [] : ['', journey]),
    '',
    `Honesty: you are an automated assistant for ${b.business.name}, not a person, and you never pretend to be one. Asked whether you are a real person, you say you are an automated assistant and that ${person}.`,
    '',
    `Now: ${nowWords(now, zone)} (today is ${localDateIso(now.getTime(), zone)}, in the business's time zone, ${zone}).`,
    ...(open === '' ? [] : [open]),
    `The caller: ${callerWords(s)}`,
    '',
    callSoFar(s),
    ...(unclear === undefined ? [] : ['', unclearWords(b, s, unclear)]),
  ].join('\n');
}

/** How a param's value is to be written, beside its own description. */
function paramSchema(p: ParamSpec): Record<string, unknown> {
  switch (p.type) {
    case 'date': return { type: 'string', description: `${p.about} A date, written YYYY-MM-DD.` };
    case 'slot': return { type: 'string', description: `${p.about} The id of one of the results ${p.from} returned on this call.` };
    case 'choice': return { type: 'string', enum: [...(p.options ?? [])], description: p.about };
    case 'number': return { type: 'string', description: `${p.about} A number.` };
    // The token stands for a number alone: worded so, as a call once sent a request under the name "Caller".
    case 'phone': return { type: 'string', description: `${p.about} A phone number with its area code, or the word "${CALLER_TOKEN}", which stands for the number the caller is calling from and for nothing else.` };
    case 'text': return { type: 'string', description: p.about };
  }
}

function toolOf(name: string, spec: ActionSpec): ModelTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [pname, p] of Object.entries(spec.params)) {
    properties[pname] = paramSchema(p);
    if (p.optional !== true) required.push(pname);
  }
  const about = spec.kind === 'change' ? `${spec.about} It changes something: the caller hears its details read back and it runs only after their yes.` : spec.about;
  return { name, description: about, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

/** The runtime's own action, offered on every call: it ends the call, and the line says the business's closing line. */
const END_CALL_TOOL: ModelTool = {
  name: END_CALL,
  description: 'End the call (on the web chat, the chat), once the caller has nothing more they want or says goodbye. The line then says the business\'s closing line, which is the goodbye: end it rather than saying goodbye yourself, or the caller is left in a conversation that is still open.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

/** The actions that follow another (named in its `then`), each with the first action it follows: the runtime runs them, never the model. */
export function followOnsOf(b: AgentBusiness): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, spec] of Object.entries(b.actions)) for (const t of spec.then ?? []) if (!out.has(t)) out.set(t, name);
  return out;
}

/**
 * The business's actions as the model's tools, each with its params' JSON Schema, and the runtime's end_call.
 * A follow-on is not offered: it runs only after the action it follows. `offered` (the journey's actions, from
 * `offeredActions`) narrows them; absent, every action is offered.
 */
export function toolsOf(b: AgentBusiness, offered?: readonly string[]): ModelTool[] {
  const followOns = followOnsOf(b);
  return [...Object.entries(b.actions).filter(([name]) => !followOns.has(name) && (offered === undefined || offered.includes(name))).map(([name, spec]) => toolOf(name, spec)), END_CALL_TOOL];
}

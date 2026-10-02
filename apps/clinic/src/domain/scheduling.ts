import {
  describeDay, isChoice, rankProbabilities, type Ack, type AnswerMap, type FormDef, type QuestionMap,
  type Session, type SummaryContext, type SummaryMove, type SummaryRead, type Thresholds,
} from 'dialogwright';
import { daypartBounds, daypartOf, minutesOf, type Booking, type Daypart } from './directory';
import { factsOf, type ClinicFacts, type Offer } from './facts';
import type { ClinicForm } from './forms';
import { ALL_SLOTS } from './slots';
import { clinicThreshold } from './thresholds';
import { callClinic } from './tools';

/**
 * The clinic's scheduling behavior, through the engine's form hooks:
 * - App.questions asks `timeOfDay` (outside a form and on a scheduling form) and `timePreference`
 *   (at a scheduling summary);
 * - FormDef.onAnswers keeps a part of the day the caller volunteers, and drops an offer whose
 *   provider or day was emptied;
 * - FormDef.onSummaryRead looks the caller's booking up and builds the offer as the summary is read, and
 *   re-reads only the day and time once the whole summary has been heard;
 * - FormDef.onSummaryAnswer moves the offer along the day's openings (earlier, later, different, or
 *   a part of the day);
 * - FormDef.keepsSlot keeps the day when "a later time that day" names it.
 */

/** Forms that book an opening the line offers: the summary names the opening, and the caller may move it. */
export const SCHEDULING_FORMS: readonly string[] = ['schedule_new', 'reschedule'] satisfies readonly ClinicForm[];
/** Forms that act on a booking the directory finds for the caller. */
export const EXISTING_FORMS: readonly string[] = ['confirm_appointment', 'cancel', 'reschedule'] satisfies readonly ClinicForm[];

/** The short re-read once only the offered day or time has moved: "{when}. Does that work?" */
export const SHORT_OFFER_PROMPT = 'confirm_time';

/** Read in place of the summary when the directory finds no booking for a form that acts on one. */
export const NO_APPOINTMENT_PROMPT = 'no_appointment_found';
/** Read in place of the summary when the provider has no opening on the day asked for. */
export const NO_OPENINGS_PROMPT = 'no_openings';

/**
 * What the form acts on is there: the booking the summary found (cancel, reschedule, confirm) and
 * the opening it offered (schedule, reschedule). Without them there is nothing to write or confirm.
 */
export function hasWhatItActsOn(form: string, f: Readonly<ClinicFacts>): boolean {
  if (EXISTING_FORMS.includes(form) && !f.existing) return false;
  if (SCHEDULING_FORMS.includes(form) && !offeredTime(f.offer)) return false;
  return true;
}

/** "Tuesday, September 22 at 2:45 PM": the one way a summary or completion says a booking. */
export function describeWhen(date: string, time: string): string {
  return `${describeDay(date)} at ${time}`;
}

/** The opening the offer names, or undefined for a day with none. */
export function offeredTime(offer: Offer | null): string | undefined {
  return offer?.times[offer.index];
}

/** The booking variables a summary or completion reads: the offered opening and the booking found. */
export function bookingVars(f: Readonly<ClinicFacts>): { when: string; time: string; existing: string } {
  const at = offeredTime(f.offer);
  return {
    // A full day has no opening to name, so it reads nothing rather than "at undefined".
    when: at && f.offer ? describeWhen(f.offer.date, at) : '',
    time: at ?? '',
    existing: f.existing ? describeWhen(f.existing.date, f.existing.time) : '',
  };
}

/** Every slot's display (empty when unfilled) and the booking variables: what a completion line may name. */
export function clinicVars(s: Session): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const id of ALL_SLOTS) vars[id] = s.slots[id]?.display ?? '';
  return { ...vars, ...bookingVars(factsOf(s)) };
}

/**
 * The index an offer opens at: the first opening inside the caller's part of the day when they named
 * one and the day has one, otherwise the day's first. `nearest` is set when the day has none in that
 * part, so the caller is told which opening they got instead.
 */
export function buildOffer(provider: string, date: string, times: string[], daypart: Daypart | null): { offer: Offer; nearest: boolean } {
  if (daypart === null || times.length === 0) return { offer: { provider, date, times, index: 0 }, nearest: false };
  const inside = times.findIndex((t) => daypartOf(t) === daypart);
  if (inside >= 0) return { offer: { provider, date, times, index: inside }, nearest: false };
  // Closest by clock distance to the part's edges. Its end is the first minute outside it, so the
  // last minute inside is `end - 1` and a time at `end` is one minute away.
  const { start, end } = daypartBounds(daypart);
  const distance = (t: string): number => {
    const m = minutesOf(t);
    return m < start ? start - m : m >= end ? m - end + 1 : 0;
  };
  let best = 0;
  times.forEach((t, i) => {
    if (distance(t) < distance(times[best]!)) best = i;
  });
  return { offer: { provider, date, times, index: best }, nearest: true };
}

function nearestAck(daypart: Daypart, time: string): Ack {
  return { promptId: 'slot_nearest', vars: { daypart, time } };
}

/** A choice answer's top label when it is not none and reaches `at`. */
function topLabel(answers: AnswerMap, id: string, at: number): string | null {
  const a = answers[id];
  const [top] = isChoice(a) ? rankProbabilities(a.probabilities) : [];
  return top && top.label !== 'none' && top.p >= at ? top.label : null;
}

/** A part of the day the caller asked for, when the model is sure enough. */
export function readDaypart(answers: AnswerMap, t: Readonly<Record<string, number>>): Daypart | null {
  return topLabel(answers, 'timeOfDay', clinicThreshold(t, 'TIME_OF_DAY')) as Daypart | null;
}

const TIME_OF_DAY: QuestionMap = {
  timeOfDay: {
    type: 'choice',
    instructions: 'Read asr.text. Does the caller say what part of the day they want the appointment in? Read only what they say about the time of day; a weekday or a date on its own says nothing about it, a greeting such as good morning or good afternoon says nothing about it, and earlier or later on their own, including later in the day, are not a part of the day; early next week or early this month is about the day, not the time of day.',
    criteria: {
      morning: 'Asks for the morning, first thing, early in the day, or a time before eleven',
      midday: 'Asks for midday, noon, lunchtime, late morning, early afternoon, or a time between eleven and two',
      afternoon: 'Asks for the afternoon, late in the day, after work, end of day, or a time from two onward',
      none: 'Says nothing about the part of the day',
    },
  },
};

const TIME_PREFERENCE: QuestionMap = {
  timePreference: {
    type: 'choice',
    instructions: 'Read asr.text and node.promptJustPlayed. The caller was offered an appointment at a specific time. Do they ask for a different time on the same day, and in which direction? A bare no, or a refusal that does not mention the time, answers the yes/no question and is none.',
    criteria: {
      earlier: 'Asks for an earlier time, or anything before the offered time, as in earlier, sooner in the day, or before that',
      later: 'Asks for a later time, or anything after the offered time, as in later, after that, or later in the day',
      different: 'Says the offered time itself does not work, without saying which way, as in not that time, a different time, or that time is no good; the time has to be what they object to',
      none: 'Accepts, says a bare no or declines without mentioning the time, names a day or a part of the day such as the morning or the afternoon, or says nothing about the time',
    },
  },
};

/**
 * The clinic's own perception questions (App.questions). A part of the day is read on the opener
 * too, so one said with the request is kept for the offer; a time preference only where an offer
 * has just been read.
 */
export function clinicQuestions(s: Session): QuestionMap {
  const q: QuestionMap = {};
  if (!s.form || SCHEDULING_FORMS.includes(s.form)) Object.assign(q, TIME_OF_DAY);
  const pc = s.pendingConfirmation;
  if (pc?.target === 'form' && SCHEDULING_FORMS.includes(pc.form)) Object.assign(q, TIME_PREFERENCE);
  return q;
}

/**
 * A scheduling form heard a spoken turn (FormDef.onAnswers): a part of the day said anywhere on it is
 * kept, the newest winning; and an offer whose provider or day has been emptied (the caller asked to
 * change it) is dropped, so the next summary builds a fresh one even if the same day comes back.
 */
export const onSchedulingAnswers: NonNullable<FormDef['onAnswers']> = ({ s, tc }, answers) => {
  const f = factsOf(s);
  const part = readDaypart(answers, tc.thresholds);
  if (part !== null) f.daypart = part;
  if (!s.slots.provider?.value || !s.slots.date?.value) f.offer = null;
};

/**
 * The summary as it is about to be read (FormDef.onSummaryRead), on the four forms that have one:
 * - a form on an existing booking looks it up (findAppointment, through the gate) from the name,
 *   birthday and provider as they stand, so a correction is read back with the booking it now
 *   points at;
 * - a scheduling form builds its offer (listOpenings) when there is none or the provider or day
 *   moved, opening inside the caller's part of the day, or at the nearest with a line saying so
 *   right before the summary; otherwise the offer stands, so a move along it survives the re-read;
 * - once the caller has heard the whole summary for this form, provider and caller, only the day
 *   and time are read again (confirm_time), as the same pending question;
 * - when there is no booking to act on, or no opening on the day, a line saying so is read in the
 *   summary's place (no_appointment_found, no_openings), never a summary with empty values.
 */
export function readSummary(c: SummaryContext): SummaryRead | null {
  const { s } = c;
  const form = s.form;
  if (!form) return null;
  const f = factsOf(s);
  const name = s.slots.name?.value ?? null;
  const dob = s.slots.dob?.value ?? null;
  const provider = s.slots.provider?.value ?? null;
  const date = s.slots.date?.value ?? null;
  f.existing = null;
  if (EXISTING_FORMS.includes(form) && name && dob && provider) {
    f.existing = callClinic(c, { tool: 'findAppointment', params: { name, dob, provider } }).value;
  }
  const acks: Ack[] = [];
  if (!SCHEDULING_FORMS.includes(form) || !provider || !date) {
    f.offer = null;
  } else if (f.offer === null || f.offer.provider !== provider || f.offer.date !== date) {
    const times = callClinic(c, { tool: 'listOpenings', params: { provider, date } }).value ?? [];
    const built = buildOffer(provider, date, times, f.daypart);
    f.offer = built.offer;
    const at = offeredTime(built.offer);
    if (built.nearest && f.daypart && at) acks.push(nearestAck(f.daypart, at));
  }
  const vars = bookingVars(f);
  // Nothing to act on: say so, as the question the caller answers. A no asks what to change (a
  // detail, or another day); a yes means the details stand, and the completion hands the caller to
  // a person (forms.ts), so nothing is written for a booking that is not there.
  if (EXISTING_FORMS.includes(form) && !f.existing) return { promptId: NO_APPOINTMENT_PROMPT, vars, acks };
  if (SCHEDULING_FORMS.includes(form) && !offeredTime(f.offer)) return { promptId: NO_OPENINGS_PROMPT, vars, acks };
  if (!SCHEDULING_FORMS.includes(form)) return { vars, acks };
  const heard = `${form}|${provider}|${name}|${dob}`;
  if (f.offer && f.summaryHeard === heard) return { promptId: SHORT_OFFER_PROMPT, vars, acks };
  f.summaryHeard = heard;
  return { vars, acks };
}

/**
 * At a scheduling summary, an answer that was neither a yes nor a correction (FormDef.onSummaryAnswer):
 * a part of the day moves the offer to its first opening (or the nearest, said once); when that
 * leaves the offer where it was, an earlier, later or different in the same breath still steps
 * from there. At an edge the offer stays and a line says so, and the turn counts on the summary's
 * ladder. `different` steps like `later` and stops at the last opening rather than wrapping, so a
 * caller who turns every opening down reaches the keypad instead of circling the day.
 */
export const moveOffer: NonNullable<FormDef['onSummaryAnswer']> = ({ s, tc }, answers): SummaryMove | null => {
  const f = factsOf(s);
  const offer = f.offer;
  if (!offer || offer.times.length === 0) return null;
  const acks: Ack[] = [];
  const part = readDaypart(answers, tc.thresholds);
  if (part !== null) {
    f.daypart = part;
    const built = buildOffer(offer.provider, offer.date, offer.times, part);
    // The summary hook keeps an offer whose provider and day are unchanged, so it adds no "closest
    // I have" of its own: this is the one the re-read carries.
    const nearest = built.nearest ? [nearestAck(part, offeredTime(built.offer)!)] : [];
    if (built.offer.index !== offer.index) {
      f.offer = built.offer;
      return { moved: true, acks: nearest };
    }
    acks.push(...nearest);
  }
  const move = topLabel(answers, 'timePreference', clinicThreshold(tc.thresholds, 'TIME_PREFERENCE'));
  if (move === null) return acks.length ? { moved: false, acks } : null;
  const last = offer.times.length - 1;
  if (move === 'earlier') {
    if (offer.index === 0) return { moved: false, acks: [...acks, { promptId: 'slot_edge_earlier', vars: {} }] };
    offer.index -= 1;
  } else {
    // later and different alike; a day with one opening is its own last.
    if (offer.index === last) return { moved: false, acks: [...acks, { promptId: 'slot_edge_later', vars: {} }] };
    offer.index += 1;
  }
  // The step leaves the opening a "closest I have" named, so that line would name a time no longer
  // offered; the summary names the new one on its own.
  return { moved: true, acks: [] };
};

/**
 * "Do you have a later appointment that day?" can read as naming the day to change and as asking
 * for a later time in one breath. At a scheduling summary a confident time move that names no new
 * day is a time request: the day is the one thing the caller wants kept (FormDef.keepsSlot).
 */
export function keepsDay(answers: AnswerMap, slot: string, t: Thresholds): boolean {
  if (slot !== 'date') return false;
  const movesTime = topLabel(answers, 'timePreference', clinicThreshold(t, 'TIME_PREFERENCE')) !== null;
  const namesDay = topLabel(answers, 'dateMode', t.SLOT_CHOICE_CONFIRM) !== null;
  return movesTime && !namesDay;
}

/** A booking as a write tool's params read it. */
export function bookingOf(f: Readonly<ClinicFacts>, provider: string, date: string): Booking | null {
  const at = offeredTime(f.offer);
  return f.offer && at && f.offer.provider === provider && f.offer.date === date ? { date, time: at } : null;
}

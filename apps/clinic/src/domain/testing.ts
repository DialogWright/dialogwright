import {
  ANONYMOUS, candidateSpans, candidateWordSpans, DATE_MODES, digitSpanLabel, dobParts, FILLER_WORDS,
  MAX_WORD_NGRAM, MONTHS, normalizeText, QUALIFIERS, RELATIVE_DAYS, saysDob, saysExplicitYear, spokenToDigits,
  tokenize, WEEKDAYS, WINDOWS, type CorpusSlotLabels, type HeuristicContext, type TestingHooks,
} from 'dialogwright';
import { PROVIDERS } from './roster';

/** The day-of-month labels, "1" .. "31", exactly as the birth date's and the day's questions offer them. */
const DAY_LABELS = Array.from({ length: 31 }, (_, i) => String(i + 1));

/**
 * The clinic for the regression harness and the decision-model stubs (App.testing): the labels its
 * corpus carries, what each stub listens for, and the state a corpus entry is seeded with. Never
 * used on a live call. Ported from an earlier version of this example's stubs, with the same readings.
 */

/** A day as the caller names it, in the vocabulary of the date slot's own questions. */
export interface DateLabel {
  mode?: string;
  month?: string;
  day?: string;
  weekday?: string;
  weekdayQualifier?: string;
  relativeDay?: string;
  window?: string;
}

/** The caller's birthday as they say it: a whole date, a month and day with the year to come, or a year on its own. */
export interface DobLabel {
  month?: string;
  day?: string;
  /** the year as spoken ("nineteen seventy five", "1975"): a span of the text */
  year?: string;
}

/** A corpus entry's slot labels, by slot. */
export interface ClinicCorpusSlots {
  /** the caller's name as spoken: a span of the text */
  name?: string;
  dob?: DobLabel;
  memberId?: { span: string; value: string };
  /** a roster key */
  provider?: string;
  date?: DateLabel;
}

const slotsOf = (labels: CorpusSlotLabels): ClinicCorpusSlots => labels as ClinicCorpusSlots;

/** Each label against what its questions can offer, so a label no question could pick fails at its id. */
function checkCorpusSlots(id: string, text: string, labels: CorpusSlotLabels): void {
  const s = slotsOf(labels);
  // The name and the birth year are spans the choice questions offer, so a label the generator never
  // produces is one no answer could pick: caught here, at the id, rather than as a quiet `none`.
  if (s.name !== undefined) {
    if (typeof s.name !== 'string' || !s.name.trim()) throw new Error(`corpus ${id}: name must be a non-empty span`);
    if (!candidateWordSpans(text).includes(normalizeText(s.name))) throw new Error(`corpus ${id}: name span "${s.name}" is not a candidate word span of the text`);
  }
  const dob = s.dob;
  if (dob !== undefined) {
    if (dob.month === undefined && dob.day === undefined && dob.year === undefined) throw new Error(`corpus ${id}: dob needs a month and day, a year, or both`);
    if ((dob.month === undefined) !== (dob.day === undefined)) throw new Error(`corpus ${id}: dob needs a month and day together`);
    if (dob.year !== undefined && !candidateSpans(text).includes(normalizeText(dob.year))) throw new Error(`corpus ${id}: dob year span "${dob.year}" is not a candidate span of the text`);
    // The month and the day are choice labels, not spans: anything else ("Mar", "31st") could only
    // be picked as `none`, and the labelled birthday would go quietly unread.
    if (dob.month !== undefined && !(MONTHS as readonly string[]).includes(dob.month)) throw new Error(`corpus ${id}: dob month "${dob.month}" is not one of the month labels`);
    if (dob.day !== undefined && !DAY_LABELS.includes(dob.day)) throw new Error(`corpus ${id}: dob day "${dob.day}" is not a day-of-month label "1".."31"`);
  }
  const member = s.memberId;
  if (member !== undefined) {
    const span = normalizeText(member.span);
    if (!candidateSpans(text).includes(span)) throw new Error(`corpus ${id}: memberId span "${member.span}" is not a candidate span of the text`);
    if (spokenToDigits(span) !== member.value) throw new Error(`corpus ${id}: memberId value ${member.value} is not the span's digits`);
  }
  if (s.provider !== undefined && !PROVIDERS.some((p) => p.key === s.provider)) throw new Error(`corpus ${id}: provider "${s.provider}" is not on the roster`);
  const date = s.date;
  if (date !== undefined) {
    const checks: ReadonlyArray<readonly [keyof DateLabel, readonly string[]]> = [
      ['mode', DATE_MODES], ['month', MONTHS], ['weekday', WEEKDAYS], ['weekdayQualifier', QUALIFIERS], ['relativeDay', RELATIVE_DAYS], ['window', WINDOWS],
    ];
    for (const [key, allowed] of checks) {
      if (date[key] !== undefined && !allowed.includes(date[key]!)) throw new Error(`corpus ${id}: date ${key} "${date[key]}" is not one of its labels`);
    }
    if (date.day !== undefined && !DAY_LABELS.includes(date.day)) throw new Error(`corpus ${id}: date day "${date.day}" is not a day-of-month label "1".."31"`);
  }
}

type Choice = NonNullable<NonNullable<TestingHooks['heuristics']>['choice']>[string];

const has = (text: string, re: RegExp): boolean => re.test(text);

// Names are short, and the cap is the span generator's own, so the stub can accept every span
// candidateWordSpans offers it. The words below are never part of a name: the filler words keep a
// span from starting or ending with one, and these are said around a name rather than in one (a
// member ID's label, the title that marks a name as the doctor's, a birthday's words).
const MAX_NAME_WORDS = MAX_WORD_NGRAM;
const NON_NAME_WORDS: ReadonlySet<string> = new Set([
  ...FILLER_WORDS, 'about', 'regarding', 'member', 'id', 'number', 'dr', 'doctor',
  'born', 'birthday', 'birth', ...MONTHS, ...WEEKDAYS, 'morning', 'midday', 'afternoon',
]);

/** A caller announcing themselves; tokenize() splits a contraction at the apostrophe, so the markers read the token stream ("it's" is "it s"). */
const NAME_MARKER = /\b(?:my name is|name is|this is|it s|i m)\s+(.+)$/;

function looksLikeName(span: string): boolean {
  const words = span.split(' ');
  return words.length <= MAX_NAME_WORDS && words.every((w) => !NON_NAME_WORDS.has(w));
}

/** The span the caller offers as their name, or null: the one right after a marker, else a two-word span that is the whole answer. */
function nameSpanOf(text: string): string | null {
  const spans = candidateWordSpans(text);
  const tail = NAME_MARKER.exec(tokenize(text).join(' '))?.[1];
  // The longest name-shaped span the text continues with right after the marker. Digits in the rest
  // of the utterance are no reason to refuse it ("my name is Morgan Ellis, member 5550 7788").
  if (tail) {
    const after = [...spans].sort((a, b) => b.length - a.length)
      .find((span) => looksLikeName(span) && (tail === span || tail.startsWith(`${span} `)));
    if (after) return after;
  }
  // No marker: a bare "Morgan Ellis", the whole answer. A two-word span found anywhere in a longer
  // sentence is not enough ("reschedule with Dr. Chen next week" offers several).
  const whole = tokenize(text).join(' ');
  return whole.split(' ').length === 2 && spans.includes(whole) ? whole : null;
}

/** The roster keys whose surnames the text says, in roster order. */
function providersNamed(text: string): string[] {
  return PROVIDERS.filter((p) => new RegExp(`\\b${p.name.toLowerCase()}\\b`).test(text)).map((p) => p.key);
}

/**
 * The day question's parts, read the way the earlier stub read them. A year said means the date is a
 * birthday's (the dob questions own it), so no part of it is a day to be seen on.
 */
function dateParts(text: string, todayIso: string): Record<'mode' | 'month' | 'day' | 'weekday' | 'weekdayQualifier' | 'relativeDay' | 'window', string> {
  if (saysExplicitYear(text, todayIso)) return { mode: 'none', month: 'none', day: 'none', weekday: 'none', weekdayQualifier: 'none', relativeDay: 'none', window: 'none' };
  const month = MONTHS.find((m) => has(text, new RegExp(`\\b${m}\\b`)));
  const weekday = WEEKDAYS.find((w) => has(text, new RegExp(`\\b${w}\\b`)));
  const window = has(text, /\bnext week\b/) ? 'next_week' : has(text, /\bthis week\b/) ? 'this_week'
    : has(text, /\bnext month\b/) ? 'next_month' : has(text, /\bthis month\b/) ? 'this_month' : 'none';
  const relative = has(text, /\bday after tomorrow\b/) ? 'day_after_tomorrow' : has(text, /\btomorrow\b/) ? 'tomorrow' : has(text, /\btoday\b/) ? 'today' : 'none';
  const dayMatch = month ? new RegExp(`\\b${month}\\s+(?:the\\s+)?(\\d{1,2})`).exec(text) : null;
  // "Tuesday of next week" names a day: the week window only qualifies which Tuesday.
  const weekWindow = window === 'next_week' || window === 'this_week' ? window : null;
  const weekdayInWindow = weekday && weekWindow ? weekday : null;
  const qualifier = weekday && has(text, new RegExp(`\\bnext\\s+${weekday}\\b`)) ? 'next'
    : weekday && has(text, new RegExp(`\\bthis\\s+${weekday}\\b`)) ? 'this'
    : weekdayInWindow ? (weekWindow === 'next_week' ? 'next' : 'this') : 'none';
  const effectiveWindow = weekdayInWindow ? 'none' : window;
  const mode = weekdayInWindow ? 'weekday'
    : effectiveWindow !== 'none' ? 'window' : relative !== 'none' ? 'relative_day' : weekday ? 'weekday' : month ? 'absolute' : 'none';
  return { mode, month: month ?? 'none', day: dayMatch ? dayMatch[1]! : 'none', weekday: weekday ?? 'none', weekdayQualifier: qualifier, relativeDay: relative, window: effectiveWindow };
}

const datePart = (key: keyof ReturnType<typeof dateParts>): Choice => (text, _labels, ctx: HeuristicContext) => ({ label: dateParts(text, ctx.todayIso)[key], p: 0.88 });

/** Which detail the caller names as wrong at the summary. A full member ID spoken here is an answer, never the field to change. */
function changeSlotOf(text: string): string {
  if (spokenToDigits(text).length >= 8) return 'none';
  if (/\b(day|date|when)\b/.test(text)) return 'date';
  if (/\b(doctor|dr|provider|who)\b/.test(text)) return 'provider';
  if (/\b(member|id|number)\b/.test(text)) return 'memberId';
  return 'none';
}

/**
 * The part of the day. Midday is tested first so "late morning" and "early afternoon" land there
 * rather than on the morning or the afternoon their second word names; a greeting ("good morning")
 * names no part of the day, and "early evening" is the afternoon, not the morning.
 */
function timeOfDayOf(text: string): string {
  if (has(text, /\b(midday|mid-day|noon|lunch|lunchtime|late morning|early afternoon)\b/)) return 'midday';
  if (has(text, /\b((?<!good )morning|first thing|early(?! (afternoon|evening|next|this))|before (eleven|11))\b/)) return 'morning';
  if (has(text, /\b((?<!good )afternoon|late in the day|after work|end of (the )?day|evening)\b/)) return 'afternoon';
  return 'none';
}

function timePreferenceOf(text: string): string {
  if (has(text, /\b(earlier|sooner|before that)\b/)) return 'earlier';
  if (has(text, /\b(later|after that)\b/)) return 'later';
  if (has(text, /\b(different time|not that time|another time|time (doesn'?t|does not|won'?t) work|no good|not that one)\b/)) return 'different';
  return 'none';
}

function providerNameStatusOf(text: string): string {
  if (providersNamed(text).length > 0) return 'neither';
  if (has(text, /\b(no|nope|don'?t know|do not know|not sure|no idea|don'?t have|do not have|can'?t remember|who are the|which doctors)\b/)) return 'no_name';
  return has(text, /^(yes|yeah|yep|i do)\b/) ? 'has_name' : 'neither';
}

const HEURISTICS: NonNullable<TestingHooks['heuristics']> = {
  intents: [
    ['reschedule', /\b(reschedule|move|change|push|different day|another day)\b/],
    ['schedule_new', /\b(schedule|book|make|set up|new appointment)\b/],
    ['cancel', /\bcancel/],
    ['confirm_appointment', /\b(confirm|check|verify|when is|do i have|still on)\b/],
    ['billing', /\b(bill|billing|charge|charged|payment|invoice|insurance|copay|owe)\b/],
  ],
  organization: 'example family practice',
  choice: {
    // Two names said (a hedge, or a correction) cannot be both: a hook answers one label, so the
    // first is named at the hedged strength, which the provider slot does not fill on.
    provider: (text) => {
      const named = providersNamed(text);
      return { label: named[0] ?? null, p: named.length > 1 ? 0.45 : 0.9 };
    },
    memberIdSpan: (_text, labels) => ({ label: digitSpanLabel(labels, 8), p: 0.9 }),
    nameSpan: (text) => ({ label: nameSpanOf(text), p: 0.9 }),
    dobMonth: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).month, p: 0.9 }),
    dobDay: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).day, p: 0.9 }),
    dobYear: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).year, p: 0.9 }),
    changeSlot: (text) => ({ label: changeSlotOf(text), p: 0.9 }),
    providerNameStatus: (text) => ({ label: providerNameStatusOf(text), p: 0.9 }),
    timeOfDay: (text) => ({ label: timeOfDayOf(text), p: 0.9 }),
    timePreference: (text) => ({ label: timePreferenceOf(text), p: 0.9 }),
    dateMode: datePart('mode'),
    dateMonth: datePart('month'),
    dateDay: datePart('day'),
    dateWeekday: datePart('weekday'),
    dateWeekdayQualifier: datePart('weekdayQualifier'),
    dateRelativeDay: datePart('relativeDay'),
    dateWindow: datePart('window'),
  },
  noul: {
    nameGiven: (text) => (nameSpanOf(text) !== null ? 0.9 : 0.05),
    dobGiven: (text, ctx) => (saysDob(text, dobParts(text, ctx.todayIso)) ? 0.9 : 0.05),
    containsMemberId: (text) => (spokenToDigits(text).length >= 4 ? 0.9 : 0.05),
    memberIdComplete: (text) => (spokenToDigits(text).length >= 8 ? 0.9 : 0.4),
  },
};

/**
 * What a yes-or-no question gets when nothing in the utterance bears on it, for the clinic's own
 * questions. (The part of the day and a time preference are choice questions: their quiet answer is
 * `none`, which the stub gives without being told.)
 */
const QUIET_NOUL: Readonly<Record<string, number>> = { containsMemberId: 0.05, memberIdComplete: 0.4, providerUnsure: 0.05 };

const LABELED: NonNullable<TestingHooks['labeled']> = {
  spans: {
    nameSpan: { what: 'name', span: (l) => slotsOf(l).name },
    dobYear: { what: 'dob year', span: (l) => slotsOf(l).dob?.year },
    memberIdSpan: { what: 'memberId', span: (l) => slotsOf(l).memberId?.span },
  },
  choice: {
    provider: (l) => slotsOf(l).provider,
    dobMonth: (l) => slotsOf(l).dob?.month,
    dobDay: (l) => slotsOf(l).dob?.day,
    dateMode: (l) => slotsOf(l).date?.mode,
    dateMonth: (l) => slotsOf(l).date?.month,
    dateDay: (l) => slotsOf(l).date?.day,
    dateWeekday: (l) => slotsOf(l).date?.weekday,
    dateWeekdayQualifier: (l) => slotsOf(l).date?.weekdayQualifier,
    dateRelativeDay: (l) => slotsOf(l).date?.relativeDay,
    dateWindow: (l) => slotsOf(l).date?.window,
    // The corpus names the part of the day, a time preference, and a hedge about the provider only on
    // entries that say one (CorpusEntry.labels: timeOfDay, timePreference, providerUnsure,
    // providerNameStatus); an entry that says none of them answers "neither" to the provider help.
    providerNameStatus: () => 'neither',
  },
  noul: {
    nameGiven: (l) => (slotsOf(l).name ? 0.92 : 0.05),
    dobGiven: (l) => (slotsOf(l).dob ? 0.92 : 0.05),
    containsMemberId: (l) => (slotsOf(l).memberId ? 0.92 : QUIET_NOUL.containsMemberId!),
    memberIdComplete: (l) => (slotsOf(l).memberId ? 0.9 : QUIET_NOUL.memberIdComplete!),
  },
};

export const CLINIC_TESTING: TestingHooks = {
  checkCorpusSlots,
  seed: {
    // The clinic verifies no one: a seeded call is the anonymous caller's.
    caller: () => ANONYMOUS,
    placeholders: {
      name: { value: 'morgan ellis', display: 'Morgan Ellis' },
      dob: { value: '1975-06-14', display: 'June 14th, 1975' },
      memberId: { value: '55507788', display: '5550 7788' },
      provider: { value: 'patel', display: 'Dr. Patel' },
      date: { value: '2026-09-22', display: 'Tuesday, September 22' },
    },
  },
  heuristics: HEURISTICS,
  labeled: LABELED,
  quietNoul: QUIET_NOUL,
  // A declined transfer offer returns to the question the caller was on: the reschedule's.
  offerTransferForm: 'reschedule',
  // Caller turns each form takes on the keypad menu: the menu digit, then each slot's keypad answer.
  dtmfBaseline: { schedule_new: 7, reschedule: 7, cancel: 5, confirm_appointment: 5, billing: 3 },
};

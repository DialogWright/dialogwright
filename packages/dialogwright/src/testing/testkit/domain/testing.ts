import type { HeuristicContext, TestingHooks } from '../../../core/app/types';
import { MONTHS, WEEKDAYS } from '../../../core/extract/date';
import { PAST_MODES, PAST_RELATIVE } from '../../../core/extract/pastDate';
import { spokenToDigits, tokenize } from '../../../core/extract/spokenNumber';
import { candidateSpans } from '../../../core/spans';
import { normalizeText } from '../../../jev/corpus';
import { dayNearMonth, digitSpanLabel, dobParts, saysExplicitYear } from '../../../jev/heuristicKit';
import { CUSTOMERS } from './data';
import { depotSearch } from './agent';
import { customerPrincipal } from './principals';
import { ACCOUNT_ID_DIGITS } from './slots/accountId';
import { AHEAD_MODES, AHEAD_RELATIVE } from './slots/deliveryDay';
import { DAYS } from './slots/dob';
import { spokenParcelNumbers } from './slots/parcelSelect';
import { DAY_PARTS } from './systems';

/**
 * Example Parcels for the regression harness and the decision-model stubs (App.testing): the labels its
 * corpus carries, what each stub listens for, and the state a corpus entry is seeded with. Never
 * used on a live call.
 */

/** A day as the caller names it, in the vocabulary of the date slots' own questions. */
export interface DayLabel {
  mode: 'relative_day' | 'weekday' | 'absolute';
  relativeDay?: string;
  weekday?: string;
  month?: string;
  day?: string;
}

/** A corpus entry's slot labels, by slot. */
export interface TestkitCorpusSlots {
  accountId?: { span: string; value: string };
  dob?: { month?: string; day?: string; year?: string };
  /** four digits: the parcelChoice label parcel_<number> */
  parcelSelect?: string;
  deliveryDay?: DayLabel;
  deliveryPart?: string;
  /** true: the words describe the missing parcel */
  missingNote?: boolean;
  expectedDate?: DayLabel;
}

const slotsOf = (labels: Readonly<Record<string, unknown>>): TestkitCorpusSlots => labels as TestkitCorpusSlots;
const without = (labels: readonly string[]): readonly string[] => labels.filter((l) => l !== 'none');

function checkDay(id: string, slot: string, d: DayLabel, modes: readonly string[], relative: readonly string[]): void {
  const bad = (what: string, v: unknown) => new Error(`corpus ${id}: ${slot} ${what} "${String(v)}" is not one of its labels`);
  if (!without(modes).includes(d.mode)) throw bad('mode', d.mode);
  if (d.relativeDay !== undefined && !without(relative).includes(d.relativeDay)) throw bad('relativeDay', d.relativeDay);
  if (d.weekday !== undefined && !(WEEKDAYS as readonly string[]).includes(d.weekday)) throw bad('weekday', d.weekday);
  if (d.month !== undefined && !(MONTHS as readonly string[]).includes(d.month)) throw bad('month', d.month);
  if (d.day !== undefined && !DAYS.includes(d.day)) throw bad('day', d.day);
  const needs: Record<DayLabel['mode'], (keyof DayLabel)[]> = { relative_day: ['relativeDay'], weekday: ['weekday'], absolute: ['day'] };
  for (const k of needs[d.mode]) if (d[k] === undefined) throw new Error(`corpus ${id}: ${slot} mode ${d.mode} needs ${k}`);
}

/** Each label against what its questions can offer, so a label no question could pick fails at its id. */
function checkCorpusSlots(id: string, text: string, labels: Readonly<Record<string, unknown>>): void {
  const s = slotsOf(labels);
  if (s.accountId !== undefined) {
    if (!candidateSpans(text).includes(normalizeText(s.accountId.span))) throw new Error(`corpus ${id}: accountId span "${s.accountId.span}" is not a candidate span of the text`);
    if (spokenToDigits(s.accountId.span) !== s.accountId.value) throw new Error(`corpus ${id}: accountId value ${s.accountId.value} is not the span's digits`);
  }
  const dob = s.dob;
  if (dob !== undefined) {
    if (dob.month === undefined && dob.day === undefined && dob.year === undefined) throw new Error(`corpus ${id}: dob needs a month and day, a year, or both`);
    if ((dob.month === undefined) !== (dob.day === undefined)) throw new Error(`corpus ${id}: dob needs a month and day together`);
    if (dob.month !== undefined && !(MONTHS as readonly string[]).includes(dob.month)) throw new Error(`corpus ${id}: dob month "${dob.month}" is not a month label`);
    if (dob.day !== undefined && !DAYS.includes(dob.day)) throw new Error(`corpus ${id}: dob day "${dob.day}" is not a day label`);
    if (dob.year !== undefined && !candidateSpans(text).includes(normalizeText(dob.year))) throw new Error(`corpus ${id}: dob year span "${dob.year}" is not a candidate span of the text`);
  }
  if (s.parcelSelect !== undefined && !/^\d{4}$/.test(s.parcelSelect)) throw new Error(`corpus ${id}: parcelSelect "${s.parcelSelect}" is not four digits`);
  if (s.deliveryDay !== undefined) {
    checkDay(id, 'deliveryDay', s.deliveryDay, AHEAD_MODES, AHEAD_RELATIVE);
    if (s.deliveryDay.mode === 'absolute' && s.deliveryDay.month === undefined) throw new Error(`corpus ${id}: deliveryDay mode absolute needs month`);
  }
  if (s.deliveryPart !== undefined && !(DAY_PARTS as readonly string[]).includes(s.deliveryPart)) throw new Error(`corpus ${id}: deliveryPart "${s.deliveryPart}" is not a part of the day`);
  if (s.missingNote !== undefined && typeof s.missingNote !== 'boolean') throw new Error(`corpus ${id}: missingNote must be a boolean`);
  if (s.expectedDate !== undefined) checkDay(id, 'expectedDate', s.expectedDate, PAST_MODES, PAST_RELATIVE);
}

interface DayParts { mode: string; relativeDay: string; weekday: string; month: string; day: string }

const NO_DAY: DayParts = { mode: 'none', relativeDay: 'none', weekday: 'none', month: 'none', day: 'none' };

/** A day named in the words: a relative day from `relative`, a weekday, or a month and day. A year means a birthday's, never this. */
function dayParts(text: string, todayIso: string, relative: Readonly<Record<string, RegExp>>): DayParts {
  if (saysExplicitYear(text, todayIso)) return NO_DAY;
  for (const [label, re] of Object.entries(relative)) if (re.test(text)) return { ...NO_DAY, mode: 'relative_day', relativeDay: label };
  const tokens = tokenize(text);
  const at = tokens.findIndex((t) => (MONTHS as readonly string[]).includes(t));
  const day = at >= 0 ? dayNearMonth(tokens, at) : null;
  if (at >= 0 && day !== null) return { ...NO_DAY, mode: 'absolute', month: tokens[at]!, day };
  const weekday = tokens.find((t) => (WEEKDAYS as readonly string[]).includes(t));
  return weekday === undefined ? NO_DAY : { ...NO_DAY, mode: 'weekday', weekday };
}

/** Order matters: the longest phrase first. */
const AHEAD: Readonly<Record<string, RegExp>> = { day_after_tomorrow: /\bday after tomorrow\b/, tomorrow: /\btomorrow\b/, today: /\btoday\b/ };
const PAST: Readonly<Record<string, RegExp>> = { day_before_yesterday: /\bday before yesterday\b/, yesterday: /\byesterday\b/, today: /\b(today|this morning)\b/ };

/** What is in each of the seed customer's parcels, as a caller names it. */
const ITEM_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['parcel_7101', /\bbooks?\b/], ['parcel_7102', /\bboots?\b/], ['parcel_7103', /\blamp\b/],
];

type Choice = NonNullable<NonNullable<TestingHooks['heuristics']>['choice']>[string];

const part = (relative: Readonly<Record<string, RegExp>>, key: keyof DayParts): Choice => (text, _labels, ctx: HeuristicContext) => ({ label: dayParts(text, ctx.todayIso, relative)[key], p: 0.9 });

const DESCRIBES_PARCEL = /\b(box|bag|envelope|porch|door|gate|step|steps|left|brown|white|small|large|it was|contained|had)\b/;

/** Which detail the caller names as wrong at the summary. */
function changeSlotOf(text: string): string {
  if (/\b(day|date|when)\b/.test(text)) return 'expectedDate';
  if (/\b(description|what was in it)\b/.test(text)) return 'missingNote';
  return 'none';
}

/** A date of birth: a month, a day and a year, or a year said on its own. */
function saysBirthday(text: string, todayIso: string): boolean {
  const p = dobParts(text, todayIso);
  if (p.month !== null && p.day !== null && p.year !== null) return true;
  return p.year !== null && p.year === tokenize(text).join(' ');
}

const HEURISTICS: NonNullable<TestingHooks['heuristics']> = {
  intents: [
    ['report_missing', /\b(missing|lost|never (arrived|came|showed up)|didn't (arrive|come)|stolen)\b/],
    ['delivery_window', /\b(delivery window|reschedule|book a (delivery|time)|time slot|deliver (it |my parcel )?(on|in|tomorrow))\b/],
    ['track_parcel', /\b(where is|where's|track|tracking|status of|parcel|package)\b/],
  ],
  organization: 'example parcels',
  choice: {
    // A number said that is one on offer; a birthday's year is not a parcel number.
    parcelChoice: (text, labels, ctx) => ({
      label: saysExplicitYear(text, ctx.todayIso) ? null : spokenParcelNumbers(text).map((n) => `parcel_${n}`).find((l) => labels.includes(l)) ?? ITEM_WORDS.find(([, re]) => re.test(text))?.[0] ?? null,
      p: 0.9,
    }),
    accountIdSpan: (_text, labels) => ({ label: digitSpanLabel(labels, ACCOUNT_ID_DIGITS), p: 0.9 }),
    dobMonth: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).month, p: 0.9 }),
    dobDay: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).day, p: 0.9 }),
    dobYear: (text, _l, ctx) => ({ label: dobParts(text, ctx.todayIso).year, p: 0.9 }),
    changeSlot: (text) => ({ label: changeSlotOf(text), p: 0.9 }),
    deliveryPart: (text) => ({ label: DAY_PARTS.find((p) => text.includes(p)) ?? null, p: 0.9 }),
    deliveryDayMode: part(AHEAD, 'mode'),
    deliveryDayRelative: part(AHEAD, 'relativeDay'),
    deliveryDayWeekday: part(AHEAD, 'weekday'),
    deliveryDayMonth: part(AHEAD, 'month'),
    deliveryDayDay: part(AHEAD, 'day'),
    expectedDateMode: part(PAST, 'mode'),
    expectedDateRelative: part(PAST, 'relativeDay'),
    expectedDateWeekday: part(PAST, 'weekday'),
    expectedDateMonth: part(PAST, 'month'),
    expectedDateDay: part(PAST, 'day'),
  },
  noul: {
    dobGiven: (text, ctx) => (saysBirthday(text, ctx.todayIso) ? 0.9 : 0.05),
    containsAccountId: (text) => (spokenToDigits(text).length >= 4 ? 0.9 : 0.05),
    accountIdComplete: (text) => (spokenToDigits(text).length >= ACCOUNT_ID_DIGITS ? 0.9 : 0.4),
    describesParcel: (text) => (DESCRIBES_PARCEL.test(text) && text.split(' ').length >= 4 ? 0.85 : 0.05),
  },
};

const QUIET_NOUL: Readonly<Record<string, number>> = { containsAccountId: 0.05, accountIdComplete: 0.4, describesParcel: 0.05 };

const LABELED: NonNullable<TestingHooks['labeled']> = {
  spans: {
    accountIdSpan: { what: 'accountId', span: (l) => slotsOf(l).accountId?.span },
    dobYear: { what: 'dob year', span: (l) => slotsOf(l).dob?.year },
  },
  choice: {
    dobMonth: (l) => slotsOf(l).dob?.month,
    dobDay: (l) => slotsOf(l).dob?.day,
    parcelChoice: (l) => (slotsOf(l).parcelSelect === undefined ? undefined : `parcel_${slotsOf(l).parcelSelect}`),
    deliveryPart: (l) => slotsOf(l).deliveryPart,
    deliveryDayMode: (l) => slotsOf(l).deliveryDay?.mode,
    deliveryDayRelative: (l) => slotsOf(l).deliveryDay?.relativeDay,
    deliveryDayWeekday: (l) => slotsOf(l).deliveryDay?.weekday,
    deliveryDayMonth: (l) => slotsOf(l).deliveryDay?.month,
    deliveryDayDay: (l) => slotsOf(l).deliveryDay?.day,
    expectedDateMode: (l) => slotsOf(l).expectedDate?.mode,
    expectedDateRelative: (l) => slotsOf(l).expectedDate?.relativeDay,
    expectedDateWeekday: (l) => slotsOf(l).expectedDate?.weekday,
    expectedDateMonth: (l) => slotsOf(l).expectedDate?.month,
    expectedDateDay: (l) => slotsOf(l).expectedDate?.day,
  },
  noul: {
    dobGiven: (l) => (slotsOf(l).dob ? 0.92 : 0.05),
    containsAccountId: (l) => (slotsOf(l).accountId ? 0.92 : 0.05),
    accountIdComplete: (l) => (slotsOf(l).accountId ? 0.9 : 0.4),
    describesParcel: (l) => (slotsOf(l).missingNote ? 0.92 : QUIET_NOUL.describesParcel!),
  },
};

/** The caller a seeded session is: Alex Rivera, signed in to level 2. */
const SEED_CUSTOMER = CUSTOMERS[0]!;

export const TESTKIT_TESTING: TestingHooks = {
  checkCorpusSlots,
  seed: {
    caller: () => customerPrincipal(SEED_CUSTOMER, 2),
    placeholders: {
      accountId: { value: '55501234', display: '5550 1234' },
      dob: { value: '1985-04-12', display: 'April 12th, 1985' },
      parcelSelect: { value: '7101', display: '7101' },
      deliveryDay: { value: '2026-09-21', display: 'Monday, September 21' },
      deliveryPart: { value: 'morning', display: 'in the morning' },
      missingNote: { value: 'a small brown box left at the side gate', display: 'your description' },
      expectedDate: { value: '2026-09-15', display: 'Tuesday, September 15' },
    },
    anythingElse: () => ({ form: 'delivery_window', call: { tool: 'getAccount', params: { accountId: SEED_CUSTOMER.id }, purpose: 'delivery_window' } }),
  },
  heuristics: HEURISTICS,
  labeled: LABELED,
  quietNoul: QUIET_NOUL,
  offerTransferForm: 'track_parcel',
  replay: { identityKeys: { accountId: '55501234', dob: '04121985' }, codeDigit: '2' },
  serviceAnswers: { depot: depotSearch },
  dtmfBaseline: { track_parcel: 5, delivery_window: 5, report_missing: 6 },
};

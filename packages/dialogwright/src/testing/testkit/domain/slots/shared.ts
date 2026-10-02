import { DAY_PARTS, type DayPart } from '../systems';

/**
 * Values the testkit's slots, its stub and its form code share. The slots themselves are library
 * types (see index.ts); this file holds only the plain values they and the rest of the app read.
 */

/** An account ID: eight digits. */
export const ACCOUNT_ID_MASK = /^\d{8}$/;
export const ACCOUNT_ID_DIGITS = 8;

/** The day-of-month labels, "1" .. "31". */
export const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

/** How the caller names a day ahead: today, tomorrow or the day after; a weekday; a month and day. */
export const AHEAD_MODES = ['relative_day', 'weekday', 'absolute', 'none'] as const;
export const AHEAD_RELATIVE = ['today', 'tomorrow', 'day_after_tomorrow', 'none'] as const;

/** How the line says each part of the day: "in the morning". */
export const DAY_PART_DISPLAY: Readonly<Record<DayPart, string>> = {
  morning: 'in the morning',
  afternoon: 'in the afternoon',
  evening: 'in the evening',
};

const isPart = (label: string): label is DayPart => (DAY_PARTS as readonly string[]).includes(label);

export const dayPartDisplay = (value: string): string => (isPart(value) ? DAY_PART_DISPLAY[value] : value);

/** The most of the caller's words a note keeps. */
export const MAX_NOTE = 500;

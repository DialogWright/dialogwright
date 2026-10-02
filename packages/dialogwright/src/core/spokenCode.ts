import type { SessionEvent } from '../channel/events';
import type { Session } from './session';

/**
 * A one-time code said aloud instead of keyed. Keyed digits never reach speech recognition, the
 * transcript or the model; a spoken code has already been through the recognizer by the time it
 * arrives, so the next best thing is that no copy of it goes any further. While the code prompt is
 * open, a run of digits in what the caller said is replaced with CODE_MASK before the words are
 * written or sent anywhere: the frame log, the trace, the console, the injection screen and
 * perception all see the mask. The code itself is then treated as exposed and a new one is sent
 * (turn.ts, `otp_spoken_reissued`).
 */
export const CODE_MASK = '[code]';

/** The fewest digits that count as a code said aloud. A code is six; a caller may give up part way. */
const MIN_DIGITS = 4;

/**
 * How many digits a spoken token stands for. "hundred" and "thousand" join a run but add none.
 * The recognizer's homophones count too ("for eight to won"): a run still needs four digits, so
 * "i want to talk to someone" is untouched, and at the code prompt over-masking is the safe side.
 */
const WORD_DIGITS: Readonly<Record<string, number>> = {
  zero: 1, oh: 1, one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1,
  won: 1, to: 1, too: 1, for: 1, ate: 1,
  ten: 2, eleven: 2, twelve: 2, thirteen: 2, fourteen: 2, fifteen: 2, sixteen: 2, seventeen: 2, eighteen: 2, nineteen: 2,
  twenty: 2, thirty: 2, forty: 2, fifty: 2, sixty: 2, seventy: 2, eighty: 2, ninety: 2,
  hundred: 0, thousand: 0,
};

/** "double five", "triple two": the multiplier's extra digits, on top of the digit that follows. */
const REPEAT: Readonly<Record<string, number>> = { double: 1, triple: 2 };

const TOKEN = /\d+|[a-z]+/gi;

function digitsOf(token: string): number | null {
  if (/^\d+$/.test(token)) return token.length;
  const w = token.toLowerCase();
  return WORD_DIGITS[w] ?? REPEAT[w] ?? null;
}

/**
 * `text` with every run of four or more spoken or written digits replaced by CODE_MASK, and whether
 * anything was. A run is number tokens separated by spaces, commas, periods or hyphens, and may
 * carry "and" between two of them ("four hundred and fifty six"). Over-masking is the safe
 * direction: at the code prompt nothing numeric is asked for aloud.
 */
export function maskSpokenCode(text: string): { text: string; masked: boolean } {
  const tokens = [...text.matchAll(TOKEN)].map((m) => ({ s: m[0], start: m.index!, end: m.index! + m[0].length, n: digitsOf(m[0]) }));
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i]!.n === null) { i++; continue; }
    let j = i;
    let digits = 0;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (t.n === null) {
        // "and" joins two number words; anything else ends the run.
        const next = tokens[j + 1];
        if (t.s.toLowerCase() === 'and' && next && next.n !== null && /^[\s,.-]*$/.test(text.slice(tokens[j - 1]!.end, t.start))) { j++; continue; }
        break;
      }
      if (j > i && !/^[\s,.-]*$/.test(text.slice(tokens[j - 1]!.end, t.start))) break;
      digits += t.n;
      j++;
    }
    // A trailing "and" is not part of the run.
    let last = j - 1;
    while (last > i && tokens[last]!.n === null) last--;
    if (digits >= MIN_DIGITS) spans.push([tokens[i]!.start, tokens[last]!.end]);
    i = j;
  }
  if (!spans.length) return { text, masked: false };
  let out = '';
  let at = 0;
  for (const [a, b] of spans) { out += text.slice(at, a) + CODE_MASK; at = b; }
  return { text: out + text.slice(at), masked: true };
}

/**
 * The event as it may be kept: at the code prompt, words (spoken or typed) with their digits
 * masked; any other event as it came. Masked where the event arrives (server/adapter.ts masks the
 * wire frame, before the frame log) and again as the turn runs (run/turn.ts), which is a no-op on
 * an event already masked and covers every path that reaches the core without the adapter.
 */
export function maskCodeEvent(promptedFor: Session['promptedFor'], e: SessionEvent): SessionEvent {
  // Only words carry the caller's code. A `user.interrupt` event's `heard` is our own prompt, as
  // far as it had played when the caller cut in (Twilio's example: "Life is a complex set of"), so
  // at the code prompt it holds the prompt's text, never the code.
  if (promptedFor !== 'otp' || (e.type !== 'user.speech' && e.type !== 'user.text')) return e;
  const m = maskSpokenCode(e.text);
  return m.masked ? { ...e, text: m.text } : e;
}

/** Whether a caller's words carry a masked code: the code was said aloud and must be replaced. */
export function saidCode(text: string): boolean {
  return text.includes(CODE_MASK);
}

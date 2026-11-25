import { sayDigits } from '../channel/sayDigits';

/**
 * The words an agent app's call sends to the voice, made speakable. The model writes as it would for a screen
 * at times, and a carrier's text-to-speech reads a screen's marks badly: on the first live calls (2026-11-25) a
 * price range "$125–$175" was said "125 175", a list's dashes and line breaks were read out or run together, and
 * the caller's last four "9110" was said "nine thousand one hundred ten". The prompt tells the model to write for
 * the ear (prompt.ts); this is the safety net for what it still writes, and for the line's own lines (a read-back,
 * a fixed line), on a call only: a chat is sent the words as written.
 *
 * It is small and exact, by what the text is, never by what a sentence means:
 * - a range of numbers joined by an en or em dash is said "<a> to <b>"; joined by a hyphen, only where a `$` or a
 *   `%` marks them as amounts (a date, 2026-11-25, and a phone number, 555-0101, keep their hyphens);
 * - a screen's list is said as speech: list markers ("- ", "* ", "1. ", "2) ") and headings ("## ") at a line's
 *   start are dropped, and each line break is a pause, a comma between lines where the line before it has no
 *   punctuation of its own; markdown's `**` is dropped;
 * - the caller's last four (the call's own value, known) are said digit by digit wherever they stand whole, by
 *   the scripted side's own rule (channel/sayDigits.ts: no digit beside them, nor across a separator of dates,
 *   times and amounts).
 *
 * A reply goes out a sentence at a time (sentences.ts), so a piece may end inside a list ("me:\n1. "): a marker
 * at its end gives the line before it its comma, and a piece that starts with a marker starts a line. What it
 * returns, made speakable again, is the same: the turn makes a read-back speakable once, and its speaker again.
 */

/** A number as a range's end may be written: an amount, a figure with its thousands or decimals, a time, a share. */
const NUM = String.raw`\$?\d+(?:[.,:]\d+)*%?`;
/** What may not touch a range's ends: a word, a mark of a figure, or a separator followed by a digit. */
const BEFORE = String.raw`(?<![\p{L}\p{N}_.,:/$\-])`;
const AFTER = String.raw`(?![\p{L}\p{N}_%$]|[.,:/\-]\p{N})`;
const DASH_RANGE = new RegExp(`${BEFORE}(${NUM}) ?[–—] ?(${NUM})${AFTER}`, 'gu');
const HYPHEN_RANGE = new RegExp(`${BEFORE}(${NUM})-(${NUM})${AFTER}`, 'gu');

/** A list's marker or a heading's at a line's start, with the space after it. */
const MARKER = /^\s*(?:#{1,6}|[-*•]|\d{1,2}[.)])(?=\s|$)\s*/u;
/** A line ending in punctuation of its own takes no comma after it. */
const PUNCTUATED = /[.,;:!?…—–\-]$/u;

const isAmount = (n: string): boolean => n.startsWith('$') || n.endsWith('%');

function ranges(text: string): string {
  const said = text.replace(DASH_RANGE, (_m, a: string, b: string) => `${a} to ${b}`);
  return said.replace(HYPHEN_RANGE, (m, a: string, b: string) => (isAmount(a) || isAmount(b) ? `${a} to ${b}` : m));
}

/** A screen's lines said as one run of speech. Text with no line break and no marker at its start is as it was. */
function lines(text: string): string {
  if (!text.includes('\n') && !MARKER.test(text)) return text;
  const lead = /^\s/.test(text) ? ' ' : '';
  const trail = /\s$/.test(text) ? ' ' : '';
  const said: string[] = [];
  // A marker after the last line said: the next item follows in the next piece, so that line takes its comma.
  let markerAfter = false;
  for (const raw of text.split(/\r?\n/)) {
    const marked = MARKER.test(raw);
    const line = raw.replace(MARKER, '').trim();
    if (line === '') {
      if (marked && said.length > 0) markerAfter = true;
      continue;
    }
    markerAfter = false;
    said.push(line);
  }
  if (said.length === 0) return lead || trail;
  let out = said[0]!;
  for (const line of said.slice(1)) out += PUNCTUATED.test(out) ? ` ${line}` : `, ${line}`;
  if (markerAfter && !PUNCTUATED.test(out)) out += ',';
  return `${lead}${out}${trail}`;
}

/** `text` as the voice is to be sent it on a call: ranges, lists and the caller's last four made speakable. */
export function forTheEar(text: string, o: { callerLastFour?: string | undefined }): string {
  let said = lines(text.replaceAll('**', ''));
  said = ranges(said);
  const four = o.callerLastFour;
  if (four !== undefined && /^\d{4}$/.test(four)) said = sayDigits(said, [four]);
  return said;
}

/** `text` as the call's channel is sent it: made speakable on a call (by the caller's number), as written on a chat. */
export function speakableOn(st: { readonly channel: 'chat' | 'voice'; readonly caller: { readonly number?: string } }, text: string): string {
  if (st.channel !== 'voice') return text;
  const digits = st.caller.number?.replace(/\D/g, '') ?? '';
  return forTheEar(text, { callerLastFour: digits.length >= 4 ? digits.slice(-4) : undefined });
}

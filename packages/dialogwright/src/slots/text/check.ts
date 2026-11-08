import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { TextOptions } from './options';
import { writtenForm } from './written';
import { foreignAddress, foreignFigure } from '../../render/checks';

/**
 * A text value the slot did not fill: not empty and at most `maxLength` characters as given (before
 * the slot writes it). It need not be a part of the words cited (a short version is allowed: the
 * drift judge holds it to them), but it has no figure or web address the words cited do not, and the
 * words cited must have been said. It is stored as the slot writes its
 * words (`numbers`, `case`), cut to `maxLength` as the fill cuts, and shown as the display says it; a
 * slot that shows the words shows them as given.
 */
export function textCheck(o: Pick<TextOptions, 'maxLength' | 'numbers' | 'case'>, display: (value: string, locale?: string) => string, showsWords: boolean): SlotValueCheck {
  return (value, words, said, ctx) => {
    const given = value.trim();
    if (given === '' || given.length > o.maxLength) return { ok: false, reason: 'shape' };
    const written = writtenForm(given, o, ctx.locale).slice(0, o.maxLength);
    // A short version carries nothing of its own: no figure (a number, an amount, a date word) and no web
    // address that the words it is cited from do not have ("The Quiet Harbor, waived fee of $40 agreed"
    // cited from "The Quiet Harbor" is refused; the agent-mode design, call 40).
    // The words count as said and as the slot writes them (numbers as digits: "seventy six twenty five" is
    // 7625), and so does the value the slot held before, which a whole value so far keeps.
    const sources = [words, writtenForm(words, o, ctx.locale), ...(ctx.held !== undefined ? [ctx.held] : [])];
    if (foreignFigure(given, sources) || foreignAddress(given, sources.join(' '))) return { ok: false, reason: 'words' };
    return wordsRefusal(words, said) ?? { ok: true, value: written, shown: display(showsWords ? given : written, ctx.locale) };
  };
}

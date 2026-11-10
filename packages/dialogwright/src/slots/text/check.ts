import type { SlotValueCheck } from '../types';
import { wordsRefusal } from '../parts/check';
import type { TextOptions } from './options';
import { writtenForm } from './written';
import { foreignAddress, foreignFigure } from '../../render/checks';
import { lexiconOf } from '../../core/extract/lexicon';

/**
 * A text value the slot did not fill: not empty and at most `maxLength` characters as given (before
 * the slot writes it). It need not be a part of the words cited (a short version is allowed: the
 * drift judge holds it to them), but it has no web address the words cited do not, and with `figures:
 * cited` no figure they do not; the words cited must have been said. It is stored as the slot writes its
 * words (`numbers`, `case`), cut to `maxLength` as the fill cuts, and shown as the display says it; a
 * slot that shows the words shows them as given.
 */
export function textCheck(o: Pick<TextOptions, 'maxLength' | 'numbers' | 'case' | 'figures'>, display: (value: string, locale?: string) => string, showsWords: boolean): SlotValueCheck {
  return (value, words, said, ctx) => {
    const given = value.trim();
    if (given === '' || given.length > o.maxLength) return { ok: false, reason: 'shape' };
    const written = writtenForm(given, o, ctx.locale).slice(0, o.maxLength);
    // The words count as said and as the slot writes them (numbers as digits: "seventy six twenty five" is
    // 7625), and so does the value the slot held before, which a whole value so far keeps.
    const sources = [words, writtenForm(words, o, ctx.locale), ...(ctx.held !== undefined ? [ctx.held] : [])];
    // A web address is never a way of writing what the caller said: one the words do not have is refused, whatever `figures` says.
    if (foreignAddress(given, sources.join(' '))) return { ok: false, reason: 'words' };
    // With `figures: cited`, a short version carries no figure of its own (a number, an amount, a date word):
    // "The Quiet Harbor, waived fee of $40 agreed" cited from "The Quiet Harbor" is refused (the agent-mode
    // design, call 40). By default (`free`, the maintainer's decision, 2026-11-10) the figures are not compared:
    // the read-back says the value, and the caller confirms it (calls 57 to 59).
    // A number said in groups is the groups written together too, in a language whose lexicon reads them ("nine eleven" 911).
    if (o.figures === 'cited' && foreignFigure(given, sources, { groups: lexiconOf(ctx.locale) })) return { ok: false, reason: 'words' };
    return wordsRefusal(words, said) ?? { ok: true, value: written, shown: display(showsWords ? given : written, ctx.locale) };
  };
}

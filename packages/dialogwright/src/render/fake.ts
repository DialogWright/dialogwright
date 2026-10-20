import type { Generation, RenderClient, RenderRequest, SpanAct, SpeechAct } from './types';
import { isSpanAct, RenderClientError } from './types';
import { isFigureWord, wordCount } from './checks';

/**
 * A render client that asks no model (tests, the stub regression, the adversarial suite): it words a
 * line from its act alone, the same way every time, so a run on it is reproducible and free. By
 * default it does what a well-behaved model would: a short acknowledgement before the fixed line where
 * the moment calls for one (the caller frustrated, a question asked again, words just heard), and for a
 * line generated from collected content, the fixed line with each content value cut to its first few
 * words, so the line summarizes rather than repeats; and a framed line's span, its content's first clause. Within the act's word budget, or the fixed line.
 *
 * `say` replaces the wording for the lines it answers (a string, a function of the act, or an Error,
 * which the line's generation then rejects with), so a test can make a renderer that adds a number,
 * injects instructions, misses an item, or fails. `delayMs` makes it slow, for the turn's budget.
 */
export interface FakeRenderOptions {
  /** By prompt id: what the fake says for that line instead of its own wording. */
  say?: Readonly<Record<string, string | Error | ((act: SpeechAct) => string)>>;
  /** For every line it does not answer through `say`: its wording, instead of the fake's own. */
  each?: (act: SpeechAct, promptId: string) => string | Error | undefined;
  /**
   * By prompt id: what the fake says for a framed line's span instead of its own wording (a string, a
   * function of the span's act and name, or an Error).
   */
  spans?: Readonly<Record<string, string | Error | ((act: SpanAct, span: string) => string)>>;
  /** For every span it does not answer through `spans`: its wording, instead of the fake's own. */
  eachSpan?: (act: SpanAct, promptId: string, span: string) => string | Error | undefined;
  /** How long each generation takes, ms; default none. */
  delayMs?: number;
}

/** The model id a fake reports. */
export const FAKE_RENDER_MODEL = 'fake-render';

/** How many words of a collected value the fake's summary keeps. */
const SUMMARY_WORDS = 8;

function summarize(value: string): string {
  const words = value.trim().split(/\s+/);
  return words.length <= SUMMARY_WORDS ? value.trim() : `${words.slice(0, SUMMARY_WORDS).join(' ').replace(/[,.;:!?]+$/, '')}...`;
}

/** The fake's own wording of an act, deterministic. */
export function fakeWording(act: SpeechAct): string {
  let line = act.fixed;
  for (const c of act.content ?? []) {
    if (c.value.trim() !== '') line = line.split(c.value).join(summarize(c.value));
  }
  // The summary's ellipsis takes the place of the content's own last stop: no "..." followed by a ".".
  line = line.replace(/\.\.\.\./g, '...');
  // A line the app says adds no acknowledgement (acknowledge: false) is the fixed line reworded, with no lead.
  const lead = act.acknowledge === false ? '' : act.frustration !== 'none' ? 'I understand. ' : act.situations.includes('re-ask') ? 'Let me ask that again. ' : act.content !== undefined ? 'Got it. ' : act.heard !== undefined && act.act === 'ask' ? 'Thanks. ' : '';
  const led = `${lead}${line}`;
  return wordCount(led) <= act.style.words ? led : line;
}

/** The caller's first person as a well-behaved model turns it toward them (the fake's own wording only: no check reads it). */
const TOWARD_CALLER: Readonly<Record<string, string>> = {
  i: 'you', me: 'you', my: 'your', mine: 'yours', we: 'you', us: 'you', our: 'your', ours: 'yours',
  "i'm": "you're", "i've": "you've", "i'll": "you'll", "i'd": "you'd", "we're": "you're", "we've": "you've", "we'll": "you'll",
};

/**
 * Words that may turn a clause around: a later clause with one is never left out of the fake's wording.
 * The fake renderer's own (a test double, so a stub run never shows a lossy read-back as generated); no
 * check reads them: on a call, what a span leaves out is the drift judge's.
 */
const TURNS_A_CLAUSE = /\b(?:no|not|never|unless|until|except|only if)\b|n['\u2019]t\b/i;

/**
 * The fake's own wording of a span, deterministic: its content's first clause (to its first comma or
 * stop), within the span's budget, with no question mark and no closing punctuation (the frame has its
 * own), as a short summary of its main point would be; but the whole content where a later clause has a
 * "no", a "not", a "never", an "n't", "unless", "until", "except" or "only if", as a careful summary
 * keeps it (then said unchanged, or over its budget falling back to the exact words). A content of one
 * clause is given back whole: the span is then said unchanged (RenderLine.unchanged). A span that speaks
 * to the caller (`speaks: to-caller`) says it turned toward them, their "I" and "my" as "you" and "your"
 * (a content with a first person is then a summary, not said unchanged). That turning is this test
 * double's own, standing in for what a model might word: no model is told it (live findings item 27).
 */
export function fakeSpanWording(act: SpanAct): string {
  const text = act.content.map((c) => c.value.trim()).filter((v) => v !== '').join(' ').replace(/\?/g, '');
  const clauses = text.split(/[,.;:!]/);
  const whole = clauses.slice(1).some((c) => TURNS_A_CLAUSE.test(c));
  const kept = whole ? text.replace(/[.!;:,\s]+$/u, '') : (clauses[0] ?? '');
  // "US" in capitals is no pronoun.
  const toward = (w: string): string => (act.speaks === 'to-caller' && w !== 'US' ? TOWARD_CALLER[w.replace(/\u2019/g, "'").toLowerCase()] ?? w : w);
  const said = kept.replace(/[\p{L}'\u2019]+/gu, toward).split(/\s+/).filter((w) => w !== '');
  return (whole ? said : said.slice(0, act.style.words)).join(' ');
}

/** Words of a question too common to tie it to a sentence of a passage. */
const COMMON = new Set(['a', 'an', 'the', 'and', 'or', 'is', 'are', 'was', 'be', 'it', 'its', "it's", 'that', 'this', 'do', 'does', 'did', 'you', 'your', 'i', 'my', 'me', 'we', 'our', 'us',
  'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'what', 'how', 'can', 'will', 'would', 'if', 'any', 'have', 'has', 'get', 'pay', 'plan', 'covered', 'cover', 'covers']);

/** A sentence a careful answer keeps whatever was asked: one with a digit, or a word that limits or turns it (a figure word or a name past its first word, too: fakeAnswerWording). */
const KEEPS = /\d|\b(?:no|not|never|unless|until|except|only|up to|but|isn't|aren't|won't|doesn't|don't|can't)\b|n['\u2019]t\b/i;

/**
 * The fake's own wording of a knowledge answer (a span `from: answer`), deterministic: the passage's
 * sentences that share a word with the caller's question (past the most common), and every sentence with a
 * figure, a name or a word that limits or turns it, in the passage's order, as a careful answer focused on
 * the question would keep them; the passage whole where that is all of it (then said unchanged). That
 * choice is this test double's own, standing in for what a model might word: no model is told it.
 */
export function fakeAnswerWording(act: SpanAct): string {
  const passage = act.content.map((c) => c.value.trim()).filter((v) => v !== '').join(' ');
  const asked = new Set((act.answer?.question ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu)?.filter((w) => !COMMON.has(w)) ?? []);
  const sentences = passage.split(/(?<=[.!])\s+/).filter((x) => x !== '');
  const named = (x: string): boolean => /\s\p{Lu}/u.test(x.slice(1));
  const tokens = (x: string): string[] => x.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const kept = sentences.filter((x) => KEEPS.test(x) || named(x) || tokens(x).some((w) => isFigureWord(w) || asked.has(w)));
  return (kept.length === 0 ? sentences : kept).join(' ');
}

/**
 * The fake's own wording of an answer from documents (a span `from: sections`), deterministic: the
 * sections' sentences that share a word with the caller's question (past the most common), at most two, in
 * the sections' order; the first section's first sentence where none does. A test double's choice, standing
 * in for what a model might word: no model is told it.
 */
export function fakeDocumentsWording(act: SpanAct): string {
  const asked = new Set((act.answer?.question ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu)?.filter((w) => !COMMON.has(w)) ?? []);
  const sentences = act.content.flatMap((c) => c.value.trim().split(/(?<=[.!?])\s+/)).filter((x) => x !== '');
  const tokens = (x: string): string[] => x.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const kept = sentences.filter((x) => tokens(x).some((w) => asked.has(w))).slice(0, 2);
  return (kept.length === 0 ? sentences.slice(0, 1) : kept).join(' ');
}

export class FakeRenderClient implements RenderClient {
  readonly model = FAKE_RENDER_MODEL;
  /** The acts it was asked to word, in order, with their prompt ids: what a test reads back. */
  readonly asked: { promptId: string; act: SpeechAct }[] = [];
  /** The framed lines' spans it was asked to word, in order, with the temperature asked where one was: what a test reads back. */
  readonly askedSpans: { promptId: string; span: string; act: SpanAct; temperature?: number }[] = [];

  constructor(private readonly opts: FakeRenderOptions = {}) {}

  async generate(req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    const { promptId, act } = req;
    if (isSpanAct(act)) this.askedSpans.push({ promptId, span: req.span ?? '', act, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) });
    else this.asked.push({ promptId, act });
    if (this.opts.delayMs !== undefined && this.opts.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new RenderClientError('aborted'));
        });
      });
    }
    let said: string | Error | undefined;
    if (isSpanAct(act)) {
      const span = req.span ?? '';
      const own = this.opts.spans && Object.hasOwn(this.opts.spans, promptId) ? this.opts.spans[promptId] : this.opts.eachSpan?.(act, promptId, span);
      said = typeof own === 'function' ? own(act, span) : own;
    } else {
      const own = this.opts.say && Object.hasOwn(this.opts.say, promptId) ? this.opts.say[promptId] : this.opts.each?.(act, promptId);
      said = typeof own === 'function' ? own(act) : own;
    }
    if (said instanceof Error) throw new RenderClientError(said.message);
    const text = said ?? (isSpanAct(act) ? (act.answer?.from === 'sections' ? fakeDocumentsWording(act) : act.answer !== undefined ? fakeAnswerWording(act) : fakeSpanWording(act)) : fakeWording(act));
    return { text, model: FAKE_RENDER_MODEL, usage: { inputTokens: Math.ceil(JSON.stringify(act).length / 4), outputTokens: Math.ceil(text.length / 4) }, latencyMs: this.opts.delayMs ?? 0, source: 'fake' };
  }
}

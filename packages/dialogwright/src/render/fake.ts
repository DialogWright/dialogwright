import type { Generation, RenderClient, RenderRequest, SpeechAct } from './types';
import { RenderClientError } from './types';
import { wordCount } from './checks';

/**
 * A render client that asks no model (tests, the stub regression, the adversarial suite): it words a
 * line from its act alone, the same way every time, so a run on it is reproducible and free. By
 * default it does what a well-behaved model would: a short acknowledgement before the fixed line where
 * the moment calls for one (the caller frustrated, a question asked again, words just heard), and for a
 * line generated from collected content, the fixed line with each content value cut to its first few
 * words, so the line summarizes rather than repeats. Within the act's word budget, or the fixed line.
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
  const lead = act.frustration !== 'none' ? 'I understand. ' : act.situations.includes('re-ask') ? 'Let me ask that again. ' : act.content !== undefined ? 'Got it. ' : act.heard !== undefined && act.act === 'ask' ? 'Thanks. ' : '';
  const led = `${lead}${line}`;
  return wordCount(led) <= act.style.words ? led : line;
}

export class FakeRenderClient implements RenderClient {
  readonly model = FAKE_RENDER_MODEL;
  /** The acts it was asked to word, in order, with their prompt ids: what a test reads back. */
  readonly asked: { promptId: string; act: SpeechAct }[] = [];

  constructor(private readonly opts: FakeRenderOptions = {}) {}

  async generate(req: RenderRequest, signal: AbortSignal): Promise<Generation> {
    const { promptId, act } = req;
    this.asked.push({ promptId, act });
    if (this.opts.delayMs !== undefined && this.opts.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new RenderClientError('aborted'));
        });
      });
    }
    const own = this.opts.say && Object.hasOwn(this.opts.say, promptId) ? this.opts.say[promptId] : this.opts.each?.(act, promptId);
    const said = typeof own === 'function' ? own(act) : own;
    if (said instanceof Error) throw new RenderClientError(said.message);
    const text = said ?? fakeWording(act);
    return { text, model: FAKE_RENDER_MODEL, usage: { inputTokens: Math.ceil(JSON.stringify(act).length / 4), outputTokens: Math.ceil(text.length / 4) }, latencyMs: this.opts.delayMs ?? 0, source: 'fake' };
  }
}

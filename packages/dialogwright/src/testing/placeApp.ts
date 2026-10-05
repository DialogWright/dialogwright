import { ANONYMOUS } from '../gate/principal';
import type { App } from '../core/app/types';
import type { SlotSpec } from '../core/slots/types';
import type { AnswerMap, JevClient, Question } from '../jev/types';
import { choice, noul, score } from './answers';
import { testkitApp } from './testkit';

/**
 * A small app for the voice options' tests: one form that asks where a problem is (`place`), with no
 * identity and no entry call, so a turn goes through no gate. The place is the caller's words as said,
 * taken once they name a street or a lane: "at" and "22" are not one, "Alder Street." is, and so are
 * "at 22 Alder Street." and "seventy six twenty five oak hollow lane".
 */
const place: SlotSpec = {
  id: 'place',
  spokenConfirm: 'summary',
  questions: () => ({}),
  fill: (_answers, ctx) => (/\b(street|lane)\b/i.test(ctx.text)
    ? { kind: 'filled', value: ctx.text.trim(), display: ctx.text.trim(), confidence: 0.95, confirm: 'none' }
    : { kind: 'absent' }),
  display: (v) => v,
};

export const PLACE_APP_ID = 'place';

export function placeApp(over: Partial<App> = {}): App {
  return {
    id: PLACE_APP_ID,
    intents: {
      agent: { criteria: 'Asks for a person', label: 'a person', kind: 'control' },
      repeat_prompt: { criteria: 'Asks to hear that again', label: 'repeat', kind: 'control' },
      report: { criteria: 'Wants to report a problem', label: 'report a problem', kind: 'form' },
      other: { criteria: 'Anything else', label: 'something else', kind: 'control' },
      none: { criteria: 'No request', label: 'nothing', kind: 'control' },
    },
    menu: [{ digit: '1', intent: 'report' }],
    forms: {
      report: {
        slots: ['place'],
        summaryPromptId: 'confirm_report',
        complete: ({ acks }) => ({ kind: 'said', acks: [...acks, { promptId: 'reported', vars: {} }] }),
      },
    },
    slots: { place },
    tools: { lookUp: { run: () => ({ value: null, summary: 'looked up' }) } },
    policy: { toolLevel: { lookUp: 0 }, purposeLevel: {}, rulesFor: { lookUp: ['R1'] }, serviceFields: {}, confirmedFields: [], maxAttempts: 3, subjects: {} },
    systems: () => ({ sys: null, lookups: { ownerOf: () => null, scopeOf: () => [] } }),
    prompts: {
      manifest: {
        ...testkitApp.prompts.manifest,
        ask_place: { text: 'Where is the problem?', interruptible: true },
        ask_place_retry: { text: 'Sorry, where is the problem?', interruptible: true },
        confirm_report: { text: 'A problem at {place}. Is that right?', interruptible: true },
        reported: { text: 'Thank you, it is reported.', interruptible: false },
      },
      tags: {},
    },
    testing: { seed: { caller: () => ANONYMOUS, placeholders: { place: { value: '22 Alder Street', display: '22 Alder Street' } } } },
    ...over,
  };
}

/** An answer to a question no test cares about: the quiet one. */
function quiet(q: Question): AnswerMap[string] {
  if (q.type === 'noul') return noul(0.02);
  if (q.type === 'score') return score(Object.fromEntries(q.levels.map((l, i) => [l.label, i === 0 ? 0.9 : 0.1 / Math.max(1, q.levels.length - 1)])));
  const labels = Object.keys(q.criteria);
  const pick = labels.includes('none') ? 'none' : labels.includes('answering') ? 'answering' : labels[0]!;
  return choice(Object.fromEntries(labels.map((l) => [l, l === pick ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])));
}

/**
 * A model that hears what a careful one would: the caller asking to report a problem, words addressed
 * to the system and complete, and nothing else. The place itself is read from the words by the slot.
 */
export function placeClient(): JevClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (req) => {
      const text = (req.state as { asr?: { text?: string } } | null)?.asr?.text ?? '';
      asked.push(text);
      const answers: AnswerMap = {};
      for (const [id, q] of Object.entries(req.questions)) answers[id] = quiet(q);
      const set = (id: string, a: AnswerMap[string]) => {
        if (Object.hasOwn(req.questions, id)) answers[id] = a;
      };
      set('addressedToSystem', noul(0.95));
      set('intelligible', noul(0.95));
      set('utteranceComplete', noul(0.9));
      set('intent', /\breport\b/i.test(text) ? choice({ report: 0.95, none: 0.05 }) : choice({ none: 0.9, other: 0.1 }));
      set('confirmsYes', noul(/^yes\b/i.test(text) ? 0.95 : 0.02));
      return { answers, model: 'place-test', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:fixture' };
    },
  };
}

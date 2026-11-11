import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_WORDING } from '../core/questions';
import type { JevClient, JevRequest, JevResponse } from '../jev/types';
import type { Seen } from './actions';
import { agentBusinessProblems } from './business/load';
import type { AgentBusiness } from './business/schema';
import { CONFIRM_NO_BELOW, CONFIRM_YES_AT, isConfirmed, readBackText, readYesNo } from './confirm';

/** The read-back said before a change, and the decision model's reading of the caller's answer to it. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'business', 'fixture', 'agent.yaml');

/** The fixture business, its read-back naming every param of the booking. */
function business(): AgentBusiness {
  const text = readFileSync(FIXTURE, 'utf8').replace(
    'for the {item}. We',
    'for the {item} ({details}). We',
  );
  const { value, problems } = agentBusinessProblems(text);
  if (!value) throw new Error(problems.map((p) => p.message).join('\n'));
  return value;
}

describe('readBackText', () => {
  const b = business();
  const seen: Seen = { availability: { results: [{ id: 'slot-7', label: 'drop off by noon' }], atMs: 1 } };
  const params = { day: '2026-11-13', window: 'slot-7', item: 'kettle', details: 'it sparks', phone: '+15555550142' };

  it('fills each placeholder with the param as its type displays it: a number the caller gave read back whole, in groups', () => {
    expect(readBackText(b, 'book', params, 'en', seen)).toBe(
      'A visit on Friday, November 13, drop off by noon, for the kettle (it sparks). We will call the number 555 555 0142. Is that right?',
    );
  });

  it('says the number calling as that, by its last four only', () => {
    expect(readBackText(b, 'book', params, 'en', seen, '+15555550142')).toContain('We will call the number the number you\'re calling from, ending in 0142.');
    expect(readBackText(b, 'book', params, 'en', seen, '+15555550199')).toContain('We will call the number 555 555 0142.');
  });

  it('says a number outside North America as it was checked, with its country code', () => {
    expect(readBackText(b, 'book', { ...params, phone: '+447700900123' }, 'en', seen)).toContain('We will call the number +447700900123.');
  });

  it('says a slot the lookup did not label by the calendar window it names', () => {
    expect(readBackText(b, 'book', { ...params, window: 'morning' }, 'en', {})).toContain('Friday, November 13, 9 to 12, for');
  });

  it('reads no label from the prototype of what was seen', () => {
    const proto = { ...b, actions: { ...b.actions, book: { ...b.actions.book!, params: { ...b.actions.book!.params, window: { type: 'slot' as const, from: 'toString', about: 'A window.' } } } } };
    expect(readBackText(proto, 'book', { ...params, window: 'w-9' }, 'en', {})).toContain('Friday, November 13, w-9, for');
  });

  it('says an optional param left out as nothing', () => {
    expect(readBackText(b, 'book', { ...params, details: '' }, 'en', seen)).toContain('for the kettle (). ');
  });

  it('throws for an action that has no read-back', () => {
    expect(() => readBackText(b, 'availability', { day: '2026-11-13' }, 'en', {})).toThrow(/availability/);
  });
});

describe('isConfirmed', () => {
  it('is a yes read clearly with no no', () => {
    expect(CONFIRM_YES_AT).toBe(0.7);
    expect(CONFIRM_NO_BELOW).toBe(0.3);
    expect(isConfirmed({ yes: 0.9, no: 0.1 })).toBe(true);
    expect(isConfirmed({ yes: 0.7, no: 0.29 })).toBe(true);
  });

  it('is not a yes that also reads as a no ("yeah, but make it four")', () => {
    expect(isConfirmed({ yes: 0.9, no: 0.6 })).toBe(false);
    expect(isConfirmed({ yes: 0.9, no: 0.3 })).toBe(false);
  });

  it('is not a weak yes, nor no reading at all', () => {
    expect(isConfirmed({ yes: 0.69, no: 0.0 })).toBe(false);
    expect(isConfirmed(null)).toBe(false);
  });
});

/** A decision model that answers each ask with `answer`, keeping what it was asked. */
function fakeJev(answer: (req: JevRequest) => Promise<JevResponse>): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    ask(req) {
      asked.push(req);
      return answer(req);
    },
  };
}

const response = (yes: number, no: number): JevResponse => ({
  answers: { confirmsYes: { type: 'noul', noul: yes }, confirmsNo: { type: 'noul', noul: no } },
  model: 'fake',
  usage: { inputTokens: 1, outputTokens: 1, estimated: true },
  latencyMs: 1,
  source: 'jev',
});

describe('readYesNo', () => {
  const readBack = 'A visit on Friday, November 13, drop off by noon, for the kettle. Is that right?';

  it('asks one request, the yes and the no of the scripted confirmation, over the read-back and what was said', async () => {
    const jev = fakeJev(async () => response(0.9, 0.1));
    expect(await readYesNo(jev, readBack, 'yes, that works', 2000)).toEqual({ yes: 0.9, no: 0.1 });
    expect(jev.asked).toHaveLength(1);
    const req = jev.asked[0]!;
    expect(req.state).toEqual({ readBack, said: 'yes, that works' });
    expect(Object.keys(req.questions)).toEqual(['confirmsYes', 'confirmsNo']);
    expect(req.questions.confirmsYes).toEqual({ type: 'noul', instructions: 'Read said and readBack. Does the caller answer yes to the confirmation question?' });
    expect(req.questions.confirmsNo).toEqual({
      type: 'noul',
      instructions: 'Read said and readBack. Does the caller answer no to the confirmation question?',
      criteria: { true: NEUTRAL_WORDING.confirmsNo.true, false: NEUTRAL_WORDING.confirmsNo.false },
    });
    expect(req.timeoutMs).toBe(2000);
  });

  it('is null when the model errs', async () => {
    const jev = fakeJev(async () => {
      throw new Error('down');
    });
    expect(await readYesNo(jev, readBack, 'yes', 2000)).toBeNull();
  });

  it('is null when the model does not answer in time, and the request is aborted', async () => {
    const jev = fakeJev(() => new Promise<JevResponse>(() => {}));
    expect(await readYesNo(jev, readBack, 'yes', 20)).toBeNull();
    expect(jev.asked[0]!.signal?.aborted).toBe(true);
  });

  it('is null when an answer is missing or not a number', async () => {
    const missing = fakeJev(async () => ({ ...response(0.9, 0.1), answers: { confirmsYes: { type: 'noul', noul: 0.9 } } }));
    expect(await readYesNo(missing, readBack, 'yes', 2000)).toBeNull();
    const wrong = fakeJev(async () => ({ ...response(0.9, 0.1), answers: { confirmsYes: { type: 'noul', noul: Number.NaN }, confirmsNo: { type: 'noul', noul: 0.1 } } }));
    expect(await readYesNo(wrong, readBack, 'yes', 2000)).toBeNull();
  });

  it('never throws, even when the client throws as it is asked', async () => {
    const jev: JevClient = {
      ask() {
        throw new Error('sync');
      },
    };
    expect(await readYesNo(jev, readBack, 'yes', 2000)).toBeNull();
  });
});

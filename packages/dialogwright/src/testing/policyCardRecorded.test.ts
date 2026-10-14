import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runScenario } from '../harness-text/runner';
import { buildClient } from '../run/client';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { traceLine } from '../trace/writer';
import { libraryApp, LIBRARY_DIR } from '../define/fixture/app';
import { MESSAGE_DIR, messageApp } from './message/app';
import { policyCardText } from './policyCard';
import { testkitApp } from './testkit';

/**
 * The policy card's "What is recorded" against what the records keep (the secretary's review, live
 * findings item 21): a value policy.yaml's `audit` records by its length is masked in the action's
 * call, but its slot, with no redact setting of its own, is kept whole wherever the call's slots are,
 * and the card says so; a slot hidden but for its year, and a statement shown in words on the live
 * console, are named the same way.
 */
afterAll(() => resetAppsForTest());

const MESSAGE = 'please call me about the March invoice before Friday, I think we were charged twice for the same delivery';

describe('the policy card says where a slot is kept otherwise than the value its action is sent', () => {
  it('a slot with no redact setting, its value recorded by its length in the action\'s call: kept whole in the trace, as the card says', async () => {
    resetAppsForTest();
    registerApp(messageApp);
    const steps = [{ say: 'can I leave a message for Dana' }, { say: "it's Morgan Lee" }, { say: 'five five five five five five zero one four two' }, { say: MESSAGE }, { say: 'yes, pass it on' }];
    const r = await runScenario({ id: 'recorded', steps, expect: { decision: 'any' } }, { client: buildClient('stub', join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl'), { ...DEFAULT_THRESHOLDS }, '2026-10-14'), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-14', now: () => 0 });
    const last = r.runs.at(-1)!;
    const gate = last.record.audit?.find((a) => a.type === 'gate');
    // The action's call: by its length (the card's table).
    expect(gate?.detail).toMatchObject({ call: `leaveMessage(recipient=dana, caller=<10 chars>, phone=...0142, message=<${MESSAGE.length} chars>)` });
    // The slot itself, in the trace file: whole.
    const line = JSON.parse(traceLine(last.record, messageApp)) as { turnState: { slots: Record<string, { value: string }> } };
    expect(line.turnState.slots.message!.value).toBe(MESSAGE);
    expect(line.turnState.slots.caller!.value).toBe('Morgan Lee');
    const card = policyCardText(messageApp, MESSAGE_DIR);
    expect(card).toContain('| Pass a message on (`leaveMessage`) | message (`message`) | by its length only |');
    expect(card).toContain("- Kept whole there, since the slot has no redact setting (policy.yaml's `audit` masks the value only in the action's call and the side effects it queues): from (`caller`) and message (`message`).");
  });

  it('a slot hidden but for its year, and a statement the live console shows in words, are named; an app where every slot is as its row says has no such paragraph', () => {
    const card = policyCardText(testkitApp, join(MESSAGE_DIR, '..', 'testkit'));
    expect(card).toContain('- Hidden there but for the year in it at most (`••/••/1985`), in a side effect\'s request too: date of birth (`dob`).');
    expect(card).toContain('- By its length there, and by its stand-in in its lines and a handoff\'s data; but, the caller\'s own words, shown as said on the live console while the call is in progress, a side effect\'s request there among them: description (`missingNote`).');
    expect(card).not.toContain('Kept whole there');
    expect(policyCardText(libraryApp, LIBRARY_DIR)).not.toContain('The slots these values come from');
  });
});

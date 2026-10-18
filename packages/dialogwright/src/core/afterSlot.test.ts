import { describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App, Completion, CompletionContext, FormDef, SlotId } from './app/types';
import { testkitApp } from '../testing/testkit';
import { runScenario, type Scenario } from '../harness-text/runner';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile } from '../run/fixtures';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { sayText } from '../channel/actions';
import type { TurnRun } from '../run/turn';

/**
 * A form's afterSlot hook (FormDef.afterSlot) and a completion's `again` (docs/designs/2026-10-18-after-slot.md),
 * on the testkit: its delivery window (a day, then a part of the day) and its missing-parcel report (a
 * note, then a date, read back for a yes).
 */

const LINES = {
  day_noted: { text: 'Let me check that day.', interruptible: false },
  day_closed: { text: 'We are closed that day.', interruptible: false },
  no_deliveries: { text: 'We are not delivering to your area this week.', interruptible: false },
  date_again: { text: 'That date did not go through.', interruptible: false },
};

type Hook = (c: CompletionContext & { readonly slot: SlotId }) => Completion | null;

function variant(forms: Partial<Record<string, Partial<FormDef>>>): App {
  const merged = Object.fromEntries(Object.entries(testkitApp.forms).map(([id, def]) => [id, { ...def, ...(forms[id] ?? {}) }]));
  return { ...testkitApp, forms: merged as App['forms'], prompts: { ...testkitApp.prompts, manifest: { ...testkitApp.prompts.manifest, ...LINES } } };
}

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

const VERIFY = [{ say: 'five five five zero one two three four' }, { say: 'april twelfth nineteen eighty five' }];
const WINDOW = [{ say: 'i want to book a delivery window' }, ...VERIFY, { say: 'the day after tomorrow' }, { say: 'afternoon' }];
const REPORT = [{ say: 'my parcel never arrived' }, ...VERIFY, { dtmf: '123456' }, { say: 'it was a small brown box left at the side gate' }, { say: 'last tuesday' }, { say: 'yes' }];

async function call(steps: Scenario['steps']): Promise<TurnRun[]> {
  const thresholds = buildThresholds([]);
  const opts = { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
  const run = await runScenario({ id: 'after-slot', steps, expect: {} } as Scenario, opts);
  return run.runs;
}

const said = (run: TurnRun): string => sayText(run.result.actions);
const promptOf = (run: TurnRun): string | undefined => (run.result.decision.kind === 'prompt' ? run.result.decision.promptId : undefined);

describe('afterSlot: a system asked between the questions', () => {
  it('runs once for each value, says its lines before the next question, and the form goes on', async () => {
    const seen: string[] = [];
    const hook: Hook = (c) => {
      seen.push(`${c.slot}=${c.s.slots[c.slot]!.value}`);
      return c.slot === 'deliveryDay' ? { kind: 'said', acks: [...c.acks, { promptId: 'day_noted', vars: {} }] } : null;
    };
    use(variant({ delivery_window: { afterSlot: hook } }));
    const runs = await call(WINDOW);
    const day = runs.at(-2)!;
    expect(said(day)).toMatch(/^Let me check that day\. /);
    expect(promptOf(day)).toBe('ask_deliveryPart');
    // Once for each value, though the form loop passes it on every turn after.
    expect(seen.filter((v) => v.startsWith('deliveryDay='))).toHaveLength(1);
    expect(seen.filter((v) => v.startsWith('deliveryPart='))).toHaveLength(1);
    expect(promptOf(runs.at(-1)!)).toBe('anything_else');
  });

  it('asks a slot again with `again`, no attempt counted, and the same value given again is seen again', async () => {
    let calls = 0;
    const hook: Hook = (c) => {
      if (c.slot !== 'deliveryDay') return null;
      calls += 1;
      return calls === 1 ? { kind: 'again', slots: ['deliveryDay'], acks: [...c.acks, { promptId: 'day_closed', vars: {} }] } : null;
    };
    use(variant({ delivery_window: { afterSlot: hook } }));
    const runs = await call([...WINDOW.slice(0, 4), { say: 'the day after tomorrow' }, { say: 'afternoon' }]);
    const first = runs[4]!;
    expect(said(first)).toMatch(/^We are closed that day\. /);
    expect(promptOf(first)).toBe('ask_deliveryDay');
    expect(first.result.session.slots.deliveryDay!.value).toBeNull();
    expect(first.result.session.slots.deliveryDay!.attempts).toBe(0);
    expect(promptOf(runs[5]!)).toBe('ask_deliveryPart');
    expect(calls).toBe(2);
    expect(promptOf(runs.at(-1)!)).toBe('anything_else');
  });

  it('ends the call on a line with `end`, the form not completed and nothing more asked', async () => {
    const hook: Hook = (c) => (c.slot === 'deliveryDay' ? { kind: 'end', promptId: 'no_deliveries', vars: {}, acks: c.acks } : null);
    use(variant({ delivery_window: { afterSlot: hook } }));
    const runs = await call(WINDOW.slice(0, 4));
    const last = runs.at(-1)!;
    expect(last.result.decision.kind).toBe('complete');
    expect(said(last)).toContain('We are not delivering to your area this week.');
    expect(last.result.session.completed).not.toContain('delivery_window');
  });

  it('runs again at the read-back for a value changed there, before the form completes', async () => {
    const seen: string[] = [];
    const hook: Hook = (c) => {
      if (c.slot === 'expectedDate') seen.push(c.s.slots.expectedDate!.value!);
      return null;
    };
    use(variant({ report_missing: { afterSlot: hook } }));
    await call([...REPORT.slice(0, 6), { say: 'no, the date is wrong' }, { say: 'yesterday' }, { say: 'yes' }]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('a completion\'s `again`', () => {
  it('empties the slots it names, asks the first again, reads the summary again, and completes on the next yes', async () => {
    const original = testkitApp.forms.report_missing!.complete;
    let tries = 0;
    const complete = (c: CompletionContext): Completion => {
      tries += 1;
      return tries === 1 ? { kind: 'again', slots: ['expectedDate'], acks: [...c.acks, { promptId: 'date_again', vars: {} }] } : original(c);
    };
    use(variant({ report_missing: { complete } }));
    const runs = await call([...REPORT, { say: 'last tuesday' }, { say: 'yes' }]);
    const at = runs.findIndex((r) => said(r).startsWith('That date did not go through.'));
    expect(at).toBeGreaterThan(0);
    const again = runs[at]!;
    expect(promptOf(again)).toBe('ask_expectedDate');
    expect(promptOf(runs[at - 1]!)).toBe('confirm_report');
    expect(again.result.session.slots.missingNote!.value).not.toBeNull();
    expect(promptOf(runs[at + 1]!)).toBe('confirm_report');
    expect(runs.at(-1)!.result.session.completed).toContain('report_missing');
    expect(tries).toBe(2);
  });
});

describe('a seeded corpus line in a form with afterSlot', () => {
  it('takes the seeded slots as seen by the hook, and writes the seed\'s facts', async () => {
    const seen: string[] = [];
    const hook: Hook = (c) => {
      seen.push(c.slot);
      return null;
    };
    const app = variant({ delivery_window: { afterSlot: hook } });
    const withFacts: App = { ...app, testing: { ...app.testing!, seed: { ...app.testing!.seed!, facts: (f) => { (f as Record<string, unknown>).seeded = true; } } } };
    use(withFacts);
    const { seedCorpusSession, startSession } = await import('../harness-text/runner');
    const s = seedCorpusSession(startSession('seeded', 0), { id: 'x', text: 'afternoon', intent: 'none', context: 'delivery_window', prompted: 'deliveryPart' } as never, { thresholds: buildThresholds([]), todayIso: REGRESS_TODAY });
    expect(s.slotsSeen).toEqual({ deliveryDay: s.slots.deliveryDay!.value });
    expect((s.facts as Record<string, unknown>).seeded).toBe(true);
    expect(seen).toEqual([]);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runScenario, type ScenarioRun, type ScenarioStep } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { choice, noul, score } from '../testing/answers';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import type { SlotSpec } from './slots/types';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession, setForm, type Session } from './session';
import { resolve, type TurnContext, type TurnResult } from './turn';
import { speechEvent } from '../channel/events';
import { VOICE_RELAY } from '../channel/caps';
import { ANONYMOUS } from '../gate/principal';
import { mockCodeVerifier } from './tools';
import { enginePrompts } from '../define/check';
import { loadAppFolder } from '../define/load';
import { SCREENED_DIR, ScreenedSystems, screenedApp, screenedCode } from '../testing/screened/app';
import { screenedVariants } from '../testing/screened/variant';

/**
 * A slot written in code that reads every spoken value back (SlotSpec.spokenConfirm `always`, no
 * readBackNo): its behaviour is pinned here as it was before the library's read-backs (design
 * 2026-10-08-confirm-on-values), since apps outside the repository rely on it. The lines it needs,
 * a no going to the keypad, the unanswered ladder, and a new value given with the summary's yes,
 * which goes to the checks and the completion rather than to a read-back.
 */

const TODAY = '2026-09-18';
const variants = screenedVariants();
afterAll(() => variants.remove());

/** The fixture with its two read-back lines for the ownership slot. */
const LINES = [
  '  confirm_ownership:',
  '    text: Just to check, {ownership}?',
  '    interruptible: true',
  '  ask_ownership_dtmf:',
  '    text: Press 1 if you own the home, or 2 if you rent it.',
  '    interruptible: true',
  '',
].join('\n');
const folder = variants.variant({ 'app.yaml': (t) => t.replace('id: screened', 'id: screened-code-always'), 'prompts.yaml': (t) => `${t}${LINES}` });

/** The ownership slot as code writes it: always read back, and nothing of the library's. */
const { readBackNo: _n, confirmValues: _v, ...library } = folder.slots.ownership! as SlotSpec;
const ownership: SlotSpec = { ...library, spokenConfirm: 'always' };
const app: App = { ...folder, slots: { ...folder.slots, ownership } };

function use(a: App): void {
  resetAppsForTest();
  registerApp(a);
}
use(screenedApp);
const corpus = loadCorpus(join(SCREENED_DIR, 'fixtures', 'corpus.jsonl'));
const client = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
beforeEach(() => use(app));

async function call(...steps: (string | ScenarioStep)[]): Promise<ScenarioRun> {
  return runScenario(
    { id: 'call', steps: steps.map((step) => (typeof step === 'string' ? { say: step } : step)), expect: { decision: 'any' } },
    { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 },
  );
}
const SILENCE: ScenarioStep = { silence: true };
const turn = (r: ScenarioRun, i: number): TurnResult => r.runs[i]!.result;
const last = (r: ScenarioRun): TurnResult => r.runs.at(-1)!.result;
const ackIds = (t: TurnResult): string[] => ('acks' in t.decision ? t.decision.acks.map((a) => a.promptId) : []);
const gates = (t: TurnResult): string[] => t.gateEvents.map((e) => `${e.decision.call.tool}:${e.decision.verdict}${e.decision.reason ? `:${e.decision.reason}` : ''}`);

describe('a code slot read back on every value (spokenConfirm: always)', () => {
  it('needs confirm_<slot> and its keypad line', () => {
    const ids = enginePrompts(loadAppFolder(SCREENED_DIR).config!, { ...screenedCode, slots: { ownership } }).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['confirm_ownership', 'ask_ownership_dtmf']));
  });

  it('is read back before the check, and a yes runs the check', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'yes');
    expect(turn(r, 2).decision).toMatchObject({ promptId: 'confirm_ownership', target: 'ownership', vars: { ownership: 'you rent it' } });
    expect(turn(r, 2).gateEvents).toEqual([]);
    expect(gates(last(r))).toEqual(['checkOwner:BLOCK:not-owner']);
  });

  it('"own" is read back too', async () => {
    const r = await call("there's water in my basement", 'yes, I own it');
    expect(last(r).decision).toMatchObject({ promptId: 'confirm_ownership' });
  });

  it('a no goes straight to the keypad, and a second no to a person', async () => {
    const r = await call("there's water in my basement", 'I rent it', 'no', 'I rent it', 'no');
    const no = turn(r, 3);
    expect(no.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_ownership_dtmf', target: 'ownership' });
    expect(ackIds(no)).toEqual(['ack_declined']);
    expect(no.session.slots.ownership).toMatchObject({ value: null, attempts: DEFAULT_THRESHOLDS.MAX_ATTEMPTS - 1 });
    expect(turn(r, 4).decision).toMatchObject({ promptId: 'confirm_ownership' });
    expect(last(r).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('a read-back nobody answers: asked again, then the keypad, then a person', async () => {
    const r = await call("there's water in my basement", 'I rent it', SILENCE, SILENCE, SILENCE);
    expect(turn(r, 3).decision).toMatchObject({ promptId: 'confirm_ownership' });
    expect(turn(r, 4).decision).toMatchObject({ promptId: 'ask_ownership_dtmf' });
    expect(last(r).decision).toMatchObject({ kind: 'handoff', reason: 'max-attempts' });
  });

  it('a new value given with the summary\'s yes goes to the checks and the completion, not to a read-back', () => {
    const t = resolve(atSummary(), speechEvent('yes, but I rent it', true), { ...PLAIN, confirmsYes: noul(0.95), confirmsNo: noul(0.02), ownership: choice({ rent: 0.95, none: 0.05 }) }, turnContext());
    expect(gates(t).at(-1)).toBe('checkOwner:BLOCK:not-owner');
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
  });

  it('a detail named with a new value (where the naming decides) goes to the checks, not to a read-back', () => {
    const decides: App = { ...app, changeSlotWithValue: 'decides' };
    use(decides);
    const answers = { ...PLAIN, confirmsYes: noul(0.02), confirmsNo: noul(0.95), changeSlot: choice({ town: 0.95, none: 0.05 }), ownership: choice({ rent: 0.95, none: 0.05 }) };
    const t = resolve(atSummary(), speechEvent('the town is wrong, and I rent it', true), answers, turnContext());
    expect(gates(t).at(-1)).toBe('checkOwner:BLOCK:not-owner');
    expect(t.decision).toMatchObject({ kind: 'complete', promptId: 'decline_renter' });
  });
});

/** The engine's own questions, each answered plainly, for a turn resolved by hand. */
const PLAIN = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }), intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
};

const turnContext = (): TurnContext => ({ nowMs: 0, todayIso: TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] }, codes: mockCodeVerifier } });

/** A session of the app at book_visit's summary, every slot filled and confirmed, its checks not yet run. */
function atSummary(): Session {
  const s: Session = newSession('pin', 0, VOICE_RELAY, ANONYMOUS, app.id);
  setForm(s, 'book_visit');
  s.entered = 'book_visit';
  const values: Record<string, [string, string]> = {
    problem: ['leak', 'a leak'], ownership: ['own', 'you own it'], town: ['ashford', 'Ashford'],
    howUrgent: ['routine', 'whenever suits'], visitDay: ['monday', 'Monday'], timeOfDay: ['morning', 'the morning'],
  };
  for (const [id, [value, display]] of Object.entries(values)) s.slots[id] = { ...s.slots[id]!, value, display, confirmed: true };
  s.pendingConfirmation = { target: 'form', form: 'book_visit', attempts: 0 };
  s.promptedFor = 'confirm';
  s.lastPromptId = 'confirm_book_visit';
  return s;
}

import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAgent } from '../../agent/fake';
import type { AgentAnswer } from '../../agent/types';
import { VOICE_RELAY } from '../../channel/caps';
import { speechEvent, startEvent, withCallerNumber } from '../../channel/events';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { newSession, type Session } from '../../core/session';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { mockCodeVerifier } from '../../core/tools';
import { businessFixtureApp } from '../../define/__fixtures__/business/app';
import { ANONYMOUS } from '../../gate/principal';
import { choiceAnswer, sharp } from '../../jev/distributions';
import { HeuristicStubClient } from '../../jev/heuristicStub';
import type { JevClient, JevRequest, JevResponse } from '../../jev/types';
import { spokenText } from '../../prompts/render';
import { runTurn } from '../../run/turn';
import type { TraceRecord } from '../../trace/types';
import { agentFactsOf, agentFiguresOf } from './agentFigures';
import { dayDataFrom, dayDataOf, factsOfTrace, FIGURES_VERSION, insightsOf, minutesToRuns, sumHours, DAY_MINUTES } from './figures';
import { summaryOfTrace } from './calls';
import { redactRecord } from './events';
import { parseFrameLog } from '../frameLog';
import { agentOf, reduce, replayEvents, scriptOf } from './view.js';

/**
 * The console's view of an agent turn (an app in agent mode): each value the agent understood with its
 * check's outcome, the action it proposed, its reply said or replaced and why, with the drift judge's
 * reading; and Insights' count of its fallbacks. On the fixture business, a fake agent and the stub.
 */

const app = businessFixtureApp;
const TODAY = '2026-11-09';
const T0 = Date.parse('2026-11-09T15:00:00Z');
const RANGE = { from: Date.parse('2026-11-09T00:00:00Z'), to: Date.parse('2026-11-09T23:59:59.999Z') };

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

function jev(): JevClient {
  const stub = new HeuristicStubClient({ todayIso: TODAY, app });
  return {
    async ask(req: JevRequest): Promise<JevResponse> {
      const r = await stub.ask(req);
      const intent = req.questions.intent;
      const text = ((req.state as { asr?: { text?: string } }).asr?.text ?? '').toLowerCase();
      if (intent === undefined || intent.type !== 'choice') return r;
      return { ...r, answers: { ...r.answers, intent: choiceAnswer(sharp(Object.keys(intent.criteria), /\bhold\b/.test(text) ? 'request' : 'none', 0.9)) } };
    },
  };
}

const said = (reply: string, values: [string, string, string][] = [], more: Partial<AgentAnswer> = {}): AgentAnswer => ({ reply, values: values.map(([field, value, words]) => ({ field, value, words })), action: 'none', fromFacts: false, ...more });

const HOLD = 'I would like to place a hold on The Quiet Harbor';
const SCRIPT: Record<string, AgentAnswer> = {
  [HOLD]: said('Happy to help. What name is it under?', [['title', 'The Quiet Harbor', 'The Quiet Harbor'], ['day', '2026-11-12', 'Thursday']]),
  'Avery Lane': said('Hi, this is Dana at the desk. How many copies?', [['patronName', 'Avery Lane', 'Avery Lane']]),
  'two please': said('Two copies, lovely. What day would you collect them?', [['copies', 'two', 'two please']]),
};

/** The call's trace records, as the server writes them and the console reads them (redacted, with what each said). */
async function records(): Promise<TraceRecord[]> {
  const tools = { ...app.systems(), codes: mockCodeVerifier };
  const agent = fakeAgent((ctx) => SCRIPT[ctx.conversation.at(-1)!.text]!, { ms: 420 });
  let at = T0;
  const o = { client: jev(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => (at += 4_000), tools, agent: { client: agent } };
  let s: Session = newSession('CA-agent', 0, VOICE_RELAY, ANONYMOUS, app.id);
  const out: TraceRecord[] = [];
  for (const e of [withCallerNumber(startEvent(), '+15555550199'), speechEvent(HOLD), speechEvent('Avery Lane'), speechEvent('two please')]) {
    const r = await runTurn(s, e, o);
    out.push(r.record);
    s = r.result.session;
  }
  return out;
}

describe('the console\'s call view of an agent turn', () => {
  it('shows each value with its check\'s outcome, the action, the reply said or replaced with why, and the judge\'s reading', async () => {
    const rs = (await records()).map((r) => redactRecord(r, app));
    const v = reduce(replayEvents(rs.map((r) => ({ ...r, spokenText: spokenText(app, r.decision, r.locale) })), []));
    const agentLines = v.lines.filter((l) => l.agent !== undefined);
    expect(agentLines).toHaveLength(3);
    const [first, second, third] = agentLines.map((l) => l.agent!);
    // A value accepted and one refused, with the words each cited; the reply not said (a value was refused), and why.
    expect(first!.values).toEqual([
      { field: 'title', value: 'The Quiet Harbor', words: 'The Quiet Harbor', outcome: 'accepted', accepted: true },
      { field: 'day', value: '2026-11-12', words: 'Thursday', outcome: 'refused: the caller never said its words; no attempt counted', accepted: false },
    ]);
    expect(first!.reply).toEqual({ text: 'Happy to help. What name is it under?', said: false, why: 'the turn said its fixed line' });
    // A reply the judge refused: replaced by its fixed line, with the judge's reading.
    expect(second!.reply).toMatchObject({ said: false, why: 'replaced by its fixed line: the judge refused it', judge: 'refused at 0.9 (cutoff 0.5)' });
    expect(second!.values[0]).toEqual({ field: 'patronName', value: 'Avery Lane', words: 'Avery Lane', outcome: 'accepted', accepted: true });
    // A reply said, with the score it passed at.
    expect(third!).toMatchObject({ use: 'used', action: 'none', ms: 420, reply: { said: true, judge: 'the judge passed it at 0.04 (cutoff 0.5)' } });
    // The script view carries it too.
    expect(scriptOf(v.lines, v.turnsView).filter((l) => l.agent !== undefined)).toHaveLength(3);
  });

  it('agentOf: a value refused with no attempt counted, and one whose words are from an earlier turn (calls 57 to 59)', () => {
    const a = agentOf({ ms: 500, use: 'used', action: 'none', replySaid: false, values: [
      { field: 'vehicle', value: 'Porsche 911', words: 'Porsche nine eleven', outcome: 'words', counted: false },
      { field: 'title', value: 'The Quiet Harbor', words: 'The Quiet Harbor', outcome: 'accepted', earlier: true },
    ] })!;
    expect(a.values.map((v) => v.outcome)).toEqual(['refused: the caller never said its words; no attempt counted', 'accepted, its words from an earlier turn']);
  });

  it('agentOf: an answer that never came, one set aside, and the price line said in a reply\'s place', () => {
    expect(agentOf({ ms: 1200, use: 'failed', fallback: 'timeout', detail: 'no answer within 1200 ms', values: [], action: 'none', replySaid: false })).toMatchObject({ use: 'failed', why: 'no answer: timeout (no answer within 1200 ms), the fixed line said' });
    expect(agentOf({ ms: 300, use: 'dropped', dropped: 'ignore', values: [], action: 'none', reply: 'Sure.', replySaid: false })).toMatchObject({ why: 'answer set aside: side speech', reply: { said: false, why: 'the turn was decided without it' } });
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', reply: 'About forty.', replySaid: false, fixedLine: 'price' })!.reply).toEqual({ text: 'About forty.', said: false, why: 'the price line was said whole in its place' });
    // A reply that takes leave of the caller where the call went on (call 55), and a value given for a full option's words.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', reply: 'Thanks for calling.', replySaid: false, closes: true })!.reply).toEqual({ text: 'Thanks for calling.', said: false, why: 'it takes leave of the caller, and the call went on' });
    expect(agentOf({ ms: 300, use: 'used', values: [{ field: 'window', value: 'afternoon', words: 'friday morning', outcome: 'full' }], action: 'none', replySaid: false })!.values[0]).toMatchObject({ outcome: "set aside: the caller's words ask for an option that is full", accepted: false });
    // The decision model's reading of a price asked (call 43): the line said, read alone, or named and not said.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, fixedLine: 'price', priceAsked: { score: 0.91, at: 0.5, named: false } })!.price).toBe('the price line said, not named by the agent: the decision model read a price asked at 0.91 (bar 0.5)');
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, priceAsked: { score: 0.04, at: 0.5, named: true } })!.price).toBe('the price line named by the agent, not said: the decision model read a price asked at 0.04 (bar 0.5)');
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'none', replySaid: false, priceAsked: { score: 0.04, at: 0.5, named: false } })!.price).toBeUndefined();
    // The action it proposed, and what the turn did with it.
    expect(agentOf({ ms: 300, use: 'used', values: [], action: 'submit', actionOutcome: 'ignored', replySaid: false })).toMatchObject({ action: 'submit', actionOutcome: 'ignored' });
    expect(agentOf(undefined)).toBeNull();
  });
});

describe('Insights: the agent\'s fallbacks', () => {
  it('a call\'s facts count its agent turns, its replies held, and those replaced, by why; kept in a day\'s file and read back', async () => {
    const rs = await records();
    expect(agentFactsOf(rs)).toEqual({ turns: 3, failed: 0, replies: 2, fellBack: 1, reasons: { drift: 1 } });
    const frames = parseFrameLog(JSON.stringify({ ts: new Date(T0 + 60_000).toISOString(), dir: 'out', msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: 'completed' }) } }));
    const row = summaryOfTrace(rs, frames, app)!;
    const d = dayDataOf([{ row: { ...row, provider: 'twilio' }, facts: factsOfTrace(rs, app) }], RANGE.from);
    const minutes = new Uint32Array(2 * DAY_MINUTES);
    minutes.set(d.minutes);
    const i = insightsOf([{ id: null, app, figures: sumHours(Object.values(d.hours)), hourCalls: {}, base: RANGE.from, minutes, peaks: {}, older: [], unreadable: [] }], undefined, RANGE);
    expect(i.agent).toEqual({ turns: 3, failed: 0, replies: 2, fellBack: 1, reasons: [{ key: 'drift', label: 'the judge refused it', n: 1 }] });
    const file = JSON.parse(JSON.stringify({ hours: d.hours, inProgress: minutesToRuns(d.minutes) }));
    expect(sumHours(Object.values(dayDataFrom(file, FIGURES_VERSION, RANGE.from)!.hours)).agent).toEqual(sumHours(Object.values(d.hours)).agent);
    // A scripted app's Insights have none; a file's malformed figures are not read.
    expect(insightsOf([], undefined, RANGE).agent).toBeUndefined();
    expect(agentFiguresOf({ turns: -1, failed: 0, replies: 0, fellBack: 0, reasons: {} })).toBeNull();
  });
});

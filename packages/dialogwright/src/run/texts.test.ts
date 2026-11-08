import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAgent } from '../agent/fake';
import type { AgentAnswer } from '../agent/types';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent, withCallerNumber, type SessionEvent } from '../channel/events';
import type { App, ToolDef } from '../core/app/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { mockCodeVerifier } from '../core/tools';
import { businessFixtureApp } from '../define/__fixtures__/business/app';
import { ANONYMOUS } from '../gate/principal';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { fakeTextProvider, TextKeys } from '../texts/record';
import { runTurn, type RunOptions, type TurnRun } from './turn';

/**
 * A tool that texts (ToolContext.texts): the run's sender is the server's provider from the app's number,
 * each text recorded in the turn's audit (text_sent) and trace (TraceRecord.texts), the number by its last
 * four and the words by their length. With no sender the tool is given none, and nothing is sent. The
 * fixture library's desk notice texts the caller's number here; the provider is a fake: no test sends a text.
 */

const TODAY = '2026-11-09';
const HOLD = 'I would like to place a hold on The Quiet Harbor';
const DETAILS = 'Avery Lane, two copies, Thursday morning, and call me at 555 555 0144';
const said = (reply: string, values: [string, string, string][] = []): AgentAnswer => ({ reply, values: values.map(([field, value, words]) => ({ field, value, words })), action: 'none', fromFacts: false });
const SCRIPT: Record<string, AgentAnswer> = {
  [HOLD]: said('Happy to help.', [['title', 'The Quiet Harbor', 'The Quiet Harbor']]),
  [DETAILS]: said('Thanks.', [['patronName', 'Avery Lane', 'Avery Lane'], ['copies', 'two', 'two copies'], ['day', '2026-11-12', 'Thursday'], ['window', 'morning', 'morning'], ['callbackNumber', '5555550144', '555 555 0144']]),
  yes: said(''),
};

/** The desk's notice, texting the caller's number that the hold is placed. */
const texting: ToolDef = {
  ...businessFixtureApp.tools.notifyDesk!,
  async run(call, _sys, ctx) {
    const r = await ctx.texts?.send({ to: call.params.callbackNumber ?? '', body: 'Your hold is placed.', ...(ctx.idempotencyKey !== undefined ? { key: ctx.idempotencyKey } : {}) });
    return { value: { ok: true }, summary: r === undefined ? 'no sender' : `texted (${r.status})` };
  },
};
const app: App = { ...businessFixtureApp, tools: { ...businessFixtureApp.tools, notifyDesk: texting } };

beforeAll(() => {
  resetAppsForTest();
  registerApp(app);
});

/** A hold placed and confirmed, with the sender given (or none). */
async function hold(texts: RunOptions['texts']): Promise<TurnRun[]> {
  const agent = fakeAgent((ctx) => SCRIPT[ctx.conversation.at(-1)!.text]!);
  const o: RunOptions = { client: new HeuristicStubClient({ todayIso: TODAY, app }), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0, tools: { ...app.systems(), codes: mockCodeVerifier }, agent: { client: agent }, texts };
  let s: Session = newSession('S-texts', 0, VOICE_RELAY, ANONYMOUS, app.id);
  const runs: TurnRun[] = [];
  for (const event of [withCallerNumber(startEvent(), '+15555550199'), speechEvent(HOLD), speechEvent(DETAILS), speechEvent('yes')] as SessionEvent[]) {
    const r = await runTurn(s, event, o);
    runs.push(r);
    s = r.result.session;
  }
  return runs;
}

describe('a tool that texts', () => {
  it('sends through the run\'s sender, from the app\'s number, recorded in the turn\'s audit and trace with no number whole and no words', async () => {
    const provider = fakeTextProvider();
    const runs = await hold({ provider, from: '+15555550100', keys: new TextKeys() });
    const yes = runs.at(-1)!;
    expect(provider.sent).toEqual([expect.objectContaining({ from: '+15555550100', to: '5555550144', body: 'Your hold is placed.' })]);
    expect(yes.record.texts).toEqual([{ direction: 'sent', number: '...0144', bodyLength: 20, media: 0, id: 'SMfake1', status: 'queued', provider: 'fake' }]);
    const row = yes.result.audit.find((d) => d.type === 'text_sent');
    expect(row).toEqual({ type: 'text_sent', detail: { number: '...0144', bodyLength: 20, media: 0, id: 'SMfake1', status: 'queued', provider: 'fake' } });
    expect(JSON.stringify(yes.record.texts)).not.toContain('5555550144');
    // The text's row follows what the turn did (the desk notice's own gate row and result).
    expect(yes.result.audit.findIndex((d) => d.type === 'text_sent')).toBe(yes.result.audit.length - 1);
  });

  it('with no sender, the tool is given none: nothing sent, nothing recorded', async () => {
    const runs = await hold(null);
    const yes = runs.at(-1)!;
    expect(yes.record.texts).toBeUndefined();
    expect(yes.result.audit.some((d) => d.type === 'text_sent')).toBe(false);
    expect(yes.result.gateEvents.some((e) => e.decision.call.tool === 'notifyDesk' && e.decision.verdict === 'ALLOW')).toBe(true);
  });
});

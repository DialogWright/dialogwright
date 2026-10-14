import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadScenarios, runScenario, type Scenario, type ScenarioRun } from '../harness-text/runner';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { JevClient, JevRequest } from '../jev/types';
import { registerApp, resetAppsForTest } from './app/registry';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { newSession } from './session';
import { VOICE_RELAY } from '../channel/caps';
import { CALLBACK_DIR, callbackApp } from '../testing/callback/app';
import { testkitApp } from '../testing/testkit';
import { callDataOf, keptCallData } from './callData';
import {
  callDataFrom, callDataSourceOf, recordedCallData, recordedCallDataMap, recordedCustomParameters, webhookParameters, webhookParametersOfKept,
} from '../channel/callData';
import { startEvent, withCallData } from '../channel/events';

/**
 * The data a call or chat came with (app.yaml's `callData`): read by key from its source, kept on the
 * session only for the keys the app names, read by the app's code with callDataOf, recorded in the
 * call_started audit row as each key's redact says, and never sent to the model. On the engine's
 * fixture for it, Example Callbacks (src/testing/callback), whose priority queue is told the callback
 * comes within the hour.
 */

const TODAY = '2026-10-09';
const FIXTURES = join(CALLBACK_DIR, 'fixtures');
const corpus = loadCorpus(join(FIXTURES, 'corpus.jsonl'), callbackApp);
const SPEC = callbackApp.callData!;

function stub(asked: JevRequest[] = []): JevClient {
  const inner = new FixtureStubClient(corpus, { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: TODAY }) });
  return { ask: (req) => { asked.push(req); return inner.ask(req); } };
}

beforeEach(() => {
  resetAppsForTest();
  registerApp(callbackApp);
});

function scenario(id: string): Scenario {
  const s = loadScenarios(join(FIXTURES, 'scenarios')).find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

async function run(s: Scenario, asked: JevRequest[] = []): Promise<ScenarioRun> {
  return runScenario(s, { client: stub(asked), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: TODAY, now: () => 0 });
}

describe('callDataFrom: each key from its source', () => {
  const provider = {
    callSid: 'CA00000000000000000000000000000001', forwardedFrom: '+15555550102', callType: 'PSTN', callerName: '',
    'param.queue': 'priority', 'param.accountRef': 'AC-55501234', 'param.other': 'x', 'param.dw_referral': 'partner-7',
  };

  it('reads a custom parameter, a setup field, a webhook field\'s echo and a chat key', () => {
    expect(callDataFrom(SPEC, provider, { page: '/orders/1042' })).toEqual({
      queue: 'priority', accountRef: 'AC-55501234', forwardedFrom: '+15555550102', referral: 'partner-7', page: '/orders/1042',
    });
  });

  it('leaves a key out when its source sent nothing, an empty value, or more than the wire takes', () => {
    expect(callDataFrom(SPEC, { 'param.queue': '', 'param.accountRef': 'x'.repeat(501) })).toEqual({});
    expect(callDataFrom({ name: { from: 'setup.callerName' } }, provider)).toEqual({});
  });

  it('takes a value with a character no start document can carry as no value, from any source', () => {
    for (const bad of ['prio\u0001rity', 'a\nb', 'a\tb', 'a\u007fb', 'a\uFFFEb', 'a\uD800b']) {
      expect(callDataFrom(SPEC, { 'param.queue': bad }, { page: bad }), JSON.stringify(bad)).toEqual({});
      expect(webhookParameters(SPEC, { 'SipHeader_X-Referral': bad })).toEqual({});
      expect(keptCallData(callbackApp, { queue: bad })).toBeUndefined();
    }
    // Letters of any script, and a pair of surrogates (an emoji), are values.
    expect(callDataFrom(SPEC, { 'param.queue': 'prioridad ñ 優先 😀' })).toEqual({ queue: 'prioridad ñ 優先 😀' });
  });

  it('reads nothing for an app without callData, and only the names it gives', () => {
    expect(callDataFrom(undefined, provider)).toEqual({});
    // `param.other` is in the setup, but no key names it.
    expect(Object.values(callDataFrom(SPEC, provider))).not.toContain('x');
  });

  it('reads the setup\'s numbers and a field passed through, never a webhook field from its own name', () => {
    // Re-pinned (live findings item 26): call data may read the setup's numbers (pnpm check warns that
    // calledOf(s) already does) and a field the wire passed through.
    expect(callDataFrom({ to: { from: 'setup.to' } }, { to: '+15555550101' })).toEqual({ to: '+15555550101' });
    expect(callDataFrom({ extra: { from: 'setup.carrierExtra' } }, { carrierExtra: 'x' })).toEqual({ extra: 'x' });
    expect(callDataFrom({ referral: { from: 'webhook.SipHeader_X-Referral' } }, { 'param.SipHeader_X-Referral': 'partner-7' })).toEqual({});
  });

  it('parses a source by its first dot, so a name may have dots of its own', () => {
    expect(callDataSourceOf('param.queue.v2')).toEqual({ kind: 'param', name: 'queue.v2' });
    expect(callDataSourceOf('header.x')).toBeNull();
    expect(callDataSourceOf('param.')).toBeNull();
  });
});

describe('webhookParameters: the answer webhook\'s fields echoed into the start document', () => {
  it('writes each field a webhook key names as dw_<key>, and only those', () => {
    expect(webhookParameters(SPEC, { CallSid: 'CA1', 'SipHeader_X-Referral': 'partner-7', From: '+15555550100' })).toEqual({ dw_referral: 'partner-7' });
  });

  it('writes nothing for a field the webhook did not carry, an empty one, or an app without such a key', () => {
    expect(webhookParameters(SPEC, { CallSid: 'CA1' })).toEqual({});
    expect(webhookParameters(SPEC, { 'SipHeader_X-Referral': '' })).toEqual({});
    expect(webhookParameters(undefined, { 'SipHeader_X-Referral': 'partner-7' })).toEqual({});
    expect(webhookParameters({ queue: { from: 'param.queue' } }, { queue: 'priority' })).toEqual({});
  });

  it('writes the same from what the session kept, for a reconnect', () => {
    expect(webhookParametersOfKept(SPEC, { referral: 'partner-7', queue: 'priority' })).toEqual({ dw_referral: 'partner-7' });
    expect(webhookParametersOfKept(SPEC, undefined)).toEqual({});
  });
});

describe('recording call data', () => {
  it('records each value as its redact says, the same when done twice', () => {
    for (const [how, v, shown] of [['last4', 'AC-55501234', '...1234'], ['last4', '42', '••••'], ['mask', 'priority', '•'], ['length', 'partner-7', '<9 chars>'], ['keep', 'priority', 'priority']] as const) {
      expect(recordedCallData(how, v)).toBe(shown);
      expect(recordedCallData(how, shown)).toBe(shown);
    }
    expect(recordedCallData('secret', 'x')).toBeNull();
  });

  it('records a map by the app\'s keys, mask where a key says nothing, secret left out', () => {
    expect(recordedCallDataMap({ ...SPEC, pin: { from: 'param.pin', redact: 'secret' } }, { queue: 'priority', accountRef: 'AC-55501234', referral: 'partner-7', pin: '1234', stray: 'x' }))
      .toEqual({ queue: 'priority', accountRef: '...1234', referral: '•', stray: '•' });
  });

  it('records the custom parameters of a setup: locale as sent, a key\'s by its redact, every other one redacted', () => {
    const params = { locale: 'es-US', queue: 'priority', accountRef: 'AC-55501234', dw_referral: 'partner-7', callReference: 'bar' };
    const once = recordedCustomParameters(SPEC, params);
    expect(once).toEqual({ locale: 'es-US', queue: 'priority', accountRef: '...1234', dw_referral: '•', callReference: 'redacted' });
    expect(recordedCustomParameters(SPEC, once)).toEqual(once);
    expect(recordedCustomParameters(undefined, params)).toEqual({ locale: 'es-US', queue: 'redacted', accountRef: 'redacted', dw_referral: 'redacted', callReference: 'redacted' });
  });

  it('takes the stricter redaction when two keys read one parameter', () => {
    expect(recordedCustomParameters({ a: { from: 'param.q', redact: 'keep' }, b: { from: 'param.q' } }, { q: 'priority' })).toEqual({ q: '•' });
  });
});

describe('the session keeps the keys the app names', () => {
  it('keeps the named keys of the start event, and nothing for an app without callData', () => {
    expect(keptCallData(callbackApp, { queue: 'priority', stray: 'x', page: '' })).toEqual({ queue: 'priority' });
    expect(keptCallData(callbackApp, {})).toBeUndefined();
    expect(keptCallData(testkitApp, { queue: 'priority' })).toBeUndefined();
  });

  it('reads as an empty object on a session that kept none', () => {
    expect(callDataOf(newSession('s', 0, VOICE_RELAY))).toEqual({});
  });

  it('is read by the app\'s code: the priority queue is told the callback comes within the hour', async () => {
    const r = await run(scenario('priority-queue'));
    expect(r.mismatches).toEqual([]);
    expect(r.pass).toBe(true);
    const session = r.runs.at(-1)!.result.session;
    expect(callDataOf(session)).toEqual({ queue: 'priority', accountRef: 'AC-55501234' });
  });

  it('on a chat too, from the page context', async () => {
    const r = await run(scenario('chat-from-page'));
    expect(r.pass).toBe(true);
    expect(callDataOf(r.runs.at(-1)!.result.session)).toEqual({ page: '/orders/1042', queue: 'priority' });
  });

  it('leaves every session of a call that came with none as it was', async () => {
    const r = await run({ ...scenario('standard-queue'), callData: undefined });
    expect(r.pass).toBe(true);
    expect('callData' in r.runs.at(-1)!.result.session).toBe(false);
  });

  it('withCallData leaves an event as it is for no data', () => {
    expect(withCallData(startEvent(), {})).toEqual(startEvent());
    expect(withCallData(startEvent(), undefined)).toEqual(startEvent());
  });
});

describe('the call_started audit row', () => {
  it('records each key as its redact says', async () => {
    const r = await run(scenario('priority-queue'));
    const started = r.runs[0]!.result.audit.find((a) => a.type === 'call_started');
    expect(started?.detail).toMatchObject({ 'callData.queue': 'priority', 'callData.accountRef': '...1234' });
  });

  it('records none for a call that came with none', async () => {
    const r = await run({ ...scenario('standard-queue'), callData: undefined });
    const started = r.runs[0]!.result.audit.find((a) => a.type === 'call_started');
    expect(Object.keys(started!.detail).some((k) => k.startsWith('callData.'))).toBe(false);
  });
});

describe('the model', () => {
  it('never sees the call data', async () => {
    const asked: JevRequest[] = [];
    const r = await run({ ...scenario('priority-queue'), callData: { queue: 'priority', accountRef: 'AC-55509876' } }, asked);
    expect(r.pass).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    const sent = JSON.stringify(asked);
    expect(sent).not.toContain('AC-55509876');
    expect(sent).not.toContain('callData');
  });
});

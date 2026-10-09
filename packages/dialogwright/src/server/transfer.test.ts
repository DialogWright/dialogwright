import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callbackApp } from '../testing/callback/app';
import { calledVariablesFrom, defaultTarget, describeDropped, dialPlan, maskTarget, parseHandoff, recordedPlan, targetNumber, transferTargetsFrom, type ServerTransfer } from './transfer';
import { dialVerb, fitHeaders, SIP_HEADERS_MAX, sipUriWithHeaders } from './voice/dial';
import { decideAction, type HttpDeps } from './http';
import { twilioProvider } from './voice/twilio';
import { telnyxProvider } from './voice/telnyx';
import { loadConfig } from './config';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { TraceWriter } from '../trace/writer';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';

/**
 * The server's side of transfer targets (design 2026-10-09-call-data-and-transfers, 2b decisions 2, 3,
 * 4 and 5): each variable the app's transfer names is read as the server starts, a posted handoff dials
 * the target it names (HANDOFF_NUMBER for a name the app does not have), a SIP address carries the
 * headers the app sends and a number none, and a call put through with no decision goes to the default.
 */

useTestkit();

const HANDOFF = '+15551234567';
const ENV = { PRIORITY_LINE: 'sip:priority@pbx.example.com', CALLBACK_DESK: '+15555550111', SECURITY_DESK: 'sip:security@pbx.example.com;transport=tls', MAIN_LINE: '+15555550100' };

function transfer(): ServerTransfer {
  return transferTargetsFrom(callbackApp, ENV, HANDOFF)!;
}

describe('the numbers a called condition reads, read as the server starts', () => {
  it('names each, and stops the server on one unset or not E.164', async () => {
    const { routedApp } = await import('../testing/routed/app');
    expect(calledVariablesFrom(routedApp, { SPANISH_LINE: '+15555550188' })).toEqual(['SPANISH_LINE']);
    expect(() => calledVariablesFrom(routedApp, {})).toThrow("a called condition (routes.yaml or app.yaml's transfer) reads SPANISH_LINE, which is not set");
    expect(() => calledVariablesFrom(routedApp, { SPANISH_LINE: 'sip:es@pbx.example.com' })).toThrow('SPANISH_LINE (read by a called condition) is not an E.164 number');
    expect(calledVariablesFrom(callbackApp, {})).toEqual([]);
  });
});

describe('the targets, read as the server starts', () => {
  it('reads each variable the transfer names, HANDOFF_NUMBER from the config', () => {
    const t = transfer();
    expect([...t.numbers]).toEqual([['PRIORITY_LINE', ENV.PRIORITY_LINE], ['CALLBACK_DESK', ENV.CALLBACK_DESK], ['SECURITY_DESK', ENV.SECURITY_DESK], ['MAIN_LINE', ENV.MAIN_LINE]]);
    expect(t.defaultVariable).toBe('MAIN_LINE');
    // HANDOFF_NUMBER is the server's own, from the config, whatever names it.
    expect(transferTargetsFrom({ transfer: { targets: [], default: 'env.HANDOFF_NUMBER' } }, {}, HANDOFF)!.numbers.get('HANDOFF_NUMBER')).toBe(HANDOFF);
    expect(transferTargetsFrom({}, {}, HANDOFF)).toBeNull();
  });

  it('refuses to start with one unset, or holding neither an E.164 number nor a sip: URI, with the fix', () => {
    expect(() => transferTargetsFrom(callbackApp, { ...ENV, CALLBACK_DESK: '' }, HANDOFF)).toThrow("app.yaml's transfer names CALLBACK_DESK, which is not set: set CALLBACK_DESK in the app's .env to an E.164 number or a sip: URI");
    expect(() => transferTargetsFrom(callbackApp, { ...ENV, CALLBACK_DESK: '555-0111' }, HANDOFF)).toThrow('CALLBACK_DESK (a transfer target in app.yaml) is neither an E.164 number');
    expect(() => transferTargetsFrom(callbackApp, { ...ENV, PRIORITY_LINE: `sip:${'a'.repeat(260)}@x` }, HANDOFF)).toThrow('is a SIP URI of more than 254 characters');
  });
});

describe('a posted handoff', () => {
  it('reads the reason, the target and the headers, each a string', () => {
    expect(parseHandoff('{"reasonCode":"live-agent","target":"PRIORITY_LINE","headers":{"X-A":"1","X-B":2}}')).toEqual({ reasonCode: 'live-agent', target: 'PRIORITY_LINE', headers: { 'X-A': '1' } });
    expect(parseHandoff('{"reasonCode":"live-agent"}')).toEqual({ reasonCode: 'live-agent' });
    expect(parseHandoff('not json')).toEqual({ reasonCode: 'unknown' });
    // A reason that is not a plain token is read as unknown, so it can never forge a log line.
    expect(parseHandoff(JSON.stringify({ reasonCode: 'live-agent\r\nforged' }))).toEqual({ reasonCode: 'unknown' });
    expect(parseHandoff(JSON.stringify({ reasonCode: 'x'.repeat(65) }))).toEqual({ reasonCode: 'unknown' });
  });

  it('dials the target it names with the headers the app sends, and HANDOFF_NUMBER for a name the app does not have', () => {
    const t = transfer();
    const plan = dialPlan(t, HANDOFF, { reasonCode: 'live-agent', target: 'PRIORITY_LINE', headers: { 'X-Queue': 'priority', 'X-Reason': 'live-agent', 'X-Injected': 'x', Accept: 'y' } });
    // Accept is no header name a transfer sends at all: counted, never named.
    expect(plan).toEqual({
      target: { to: ENV.PRIORITY_LINE, headers: { 'X-Queue': 'priority', 'X-Reason': 'live-agent' } },
      variable: 'PRIORITY_LINE', sent: ['X-Queue', 'X-Reason'], dropped: [{ name: 'X-Injected', why: 'unknown' }], notHeaders: 1,
    });
    expect(dialPlan(t, HANDOFF, { reasonCode: 'live-agent', target: 'SOMEWHERE_ELSE' }).target).toEqual({ to: HANDOFF });
    // An app without transfer dials HANDOFF_NUMBER whatever the data says, and sends nothing more.
    expect(dialPlan(null, HANDOFF, { reasonCode: 'live-agent', target: 'PRIORITY_LINE', headers: { 'X-Queue': 'p' } })).toEqual({ target: { to: HANDOFF }, variable: 'HANDOFF_NUMBER', sent: [], dropped: [], notHeaders: 0 });
    expect(dialPlan(null, HANDOFF, { reasonCode: 'unreadable' }).target).toEqual({ to: HANDOFF });
  });

  it('a handoff that names no target (a saved call the server cannot read, ended on its socket) goes to the default, not HANDOFF_NUMBER', () => {
    // The fixture's default is MAIN_LINE, another variable than HANDOFF_NUMBER, so the two cannot be mistaken.
    expect(dialPlan(transfer(), HANDOFF, parseHandoff('{"reasonCode":"unreadable"}'))).toEqual({ target: { to: ENV.MAIN_LINE }, variable: 'MAIN_LINE', sent: [], dropped: [], notHeaders: 0 });
    expect(dialPlan(transfer(), HANDOFF, parseHandoff('{"reasonCode":"x","target":"ANTHROPIC_API_KEY"}')).target).toEqual({ to: HANDOFF });
  });

  it('names only header names in what it left out, with why: a forged name is counted, never written', () => {
    const t = transferTargetsFrom({ transfer: { targets: [{ when: [], to: 'env.SIP_DESK', send: { headers: { 'X-Reason': 'reason' } } }], default: 'env.MAIN_LINE' } }, { SIP_DESK: 'sip:desk@pbx.example.com', MAIN_LINE: '+15555550100' }, HANDOFF)!;
    const posted = parseHandoff(JSON.stringify({ reasonCode: 'x', target: 'SIP_DESK', headers: { 'X-Reason': 'a&b', 'x-reason': 'dup', 'X-Other': 'no', 'X-Reason\r\nVia': 'z', 'X-Reason\n': 'z' } }));
    const plan = dialPlan(t, HANDOFF, posted);
    expect(plan.target).toEqual({ to: 'sip:desk@pbx.example.com', headers: { 'X-Reason': 'a&b' } });
    expect(plan.dropped).toEqual([{ name: 'x-reason', why: 'duplicate' }, { name: 'X-Other', why: 'unknown' }]);
    expect(plan.notHeaders).toBe(2);
    expect(describeDropped(plan)).toBe('X-Other: not ones app.yaml sends; x-reason: a name already sent in another case; and 2 more not header names');
    expect(JSON.stringify(recordedPlan(plan))).not.toContain('Via');
    // A value a dial document cannot carry (a lone surrogate, which encodeURIComponent would throw on) has its own why.
    const lone = dialPlan(t, HANDOFF, parseHandoff('{"reasonCode":"x","target":"SIP_DESK","headers":{"X-Reason":"\\ud800"}}'));
    expect(lone.dropped).toEqual([{ name: 'X-Reason', why: 'value' }]);
    expect(describeDropped(lone)).toBe('X-Reason: a value a dial document cannot carry');
  });

  it('lists at most ten dropped names, and counts the rest', () => {
    const headers = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`X-H${i}`, 'v']));
    const plan = dialPlan(transfer(), HANDOFF, { reasonCode: 'x', target: 'CALLBACK_DESK', headers });
    expect(plan.dropped).toHaveLength(14);
    expect(describeDropped(plan)).toBe(`${Array.from({ length: 10 }, (_, i) => `X-H${i}`).join(', ')}: not ones app.yaml sends; and 4 more`);
    expect(recordedPlan(plan)).toMatchObject({ target: 'CALLBACK_DESK', moreDropped: 4 });
    expect((recordedPlan(plan).dropped as unknown[]).length).toBe(10);
  });

  it('leaves the headers out for a phone number, which carries none', () => {
    expect(dialPlan(transfer(), HANDOFF, { reasonCode: 'max-attempts', target: 'CALLBACK_DESK', headers: { 'X-Reason': 'max-attempts' } })).toEqual({
      target: { to: ENV.CALLBACK_DESK }, variable: 'CALLBACK_DESK', sent: [], dropped: [{ name: 'X-Reason', why: 'number' }], notHeaders: 0,
    });
  });

  it('a call with no decision goes to the default; the console sees a target masked', () => {
    expect(defaultTarget(transfer(), HANDOFF)).toEqual({ to: ENV.MAIN_LINE });
    expect(defaultTarget(null, HANDOFF)).toEqual({ to: HANDOFF });
    expect(maskTarget(ENV.SECURITY_DESK)).toBe('sip:…@pbx.example.com');
    expect(maskTarget('+15555550111')).toBe('…0111');
    expect(targetNumber(transfer(), HANDOFF, 'PRIORITY_LINE')).toBe(ENV.PRIORITY_LINE);
    expect(targetNumber(transfer(), HANDOFF, 'NOPE')).toBe(HANDOFF);
  });
});

describe('the dial document', () => {
  it('writes a number as it always has, and a SIP address in a <Sip> with its headers encoded and escaped', () => {
    expect(dialVerb({ to: HANDOFF })).toBe(`<Dial>${HANDOFF}</Dial>`);
    expect(dialVerb({ to: HANDOFF, headers: { 'X-A': '1' } })).toBe(`<Dial>${HANDOFF}</Dial>`);
    expect(dialVerb({ to: 'sip:desk@pbx.example.com', headers: { 'X-Account-Ref': '...1234', 'X-Note': 'a&b <c>' } }))
      .toBe('<Dial><Sip>sip:desk@pbx.example.com?X-Account-Ref=...1234&amp;X-Note=a%26b%20%3Cc%3E</Sip></Dial>');
    expect(sipUriWithHeaders('sip:desk@pbx.example.com?X-Own=1', { 'X-A': 'b' })).toBe('sip:desk@pbx.example.com?X-Own=1&X-A=b');
    expect(twilioProvider.dialDocument({ to: 'sip:desk@pbx.example.com', headers: { 'User-to-User': '3a2b' } })).toContain('<Dial><Sip>sip:desk@pbx.example.com?User-to-User=3a2b</Sip></Dial>');
    expect(telnyxProvider.dialDocument({ to: 'sip:desk@pbx.example.com', headers: { 'User-to-User': '3a2b' } })).toContain('<Dial><Sip>sip:desk@pbx.example.com?User-to-User=3a2b</Sip></Dial>');
  });

  it('holds the headers under 1024 characters once encoded, leaving out each that would go over', () => {
    const big = 'x'.repeat(600);
    const fit = fitHeaders('sip:desk@pbx.example.com', { 'X-A': big, 'X-B': big, 'X-C': 'small' });
    expect(Object.keys(fit.kept)).toEqual(['X-A', 'X-C']);
    expect(fit).toMatchObject({ dropped: ['X-B'], why: 'size' });
    const uri = sipUriWithHeaders('sip:desk@pbx.example.com', fit.kept);
    expect(uri.slice(uri.indexOf('?') + 1).length).toBeLessThanOrEqual(SIP_HEADERS_MAX);
    expect(dialVerb({ to: 'sip:desk@pbx.example.com', headers: { 'X-A': big, 'X-B': big } })).not.toContain('X-B');
  });
});

describe('decideAction', () => {
  function deps(withTransfer: boolean): HttpDeps & { dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-'));
    const config = loadConfig({ PUBLIC_HOST: 'demo.ngrok.app', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: HANDOFF, RECONNECT_LIMIT: '0', AUDIO_DIR: dir, CHAT: 'off' });
    const store = new SessionStore((callSid) => ({
      session: newSession(callSid, 0, VOICE_RELAY),
      opts: { client: new HeuristicStubClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-09' },
      trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
      frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`)),
    }), 60_000);
    return { config, store, tokens: new CallTokens(60_000), hints: '', log: () => {}, dir, ...(withTransfer ? { transfer: transfer() } : {}) };
  }

  it('dials the chosen SIP target with its headers, and writes the target and the headers sent to the frame log', () => {
    const d = deps(true);
    d.store.create('CA1', { send: () => {}, close: () => {} });
    const handoffData = JSON.stringify({ reasonCode: 'live-agent', target: 'PRIORITY_LINE', headers: { 'X-Queue': 'priority' } });
    const r = decideAction(d, twilioProvider, { callId: 'CA1', raw: {}, handoffData });
    expect(r.document).toContain('<Dial><Sip>sip:priority@pbx.example.com?X-Queue=priority</Sip></Dial>');
    expect(r.note).toBe('dial:live-agent to PRIORITY_LINE');
    const log = readFileSync(join(d.dir, 'CA1.frames.jsonl'), 'utf8');
    expect(log).toContain('"transfer":{"target":"PRIORITY_LINE","sent":["X-Queue"]}');
  });

  it('dials a number target without its headers, and says which were left out', () => {
    const d = deps(true);
    d.store.create('CA2', { send: () => {}, close: () => {} });
    const r = decideAction(d, telnyxProvider, { callId: 'CA2', raw: {}, handoffData: JSON.stringify({ reasonCode: 'max-attempts', target: 'CALLBACK_DESK', headers: { 'X-Reason': 'max-attempts' } }) });
    expect(r.document).toContain(`<Dial>${ENV.CALLBACK_DESK}</Dial>`);
    expect(r.note).toBe('dial:max-attempts to CALLBACK_DESK (headers left out: X-Reason: a phone number carries none)');
    expect(readFileSync(join(d.dir, 'CA2.frames.jsonl'), 'utf8')).toContain('"transfer":{"target":"CALLBACK_DESK","dropped":[{"name":"X-Reason","why":"number"}]}');
  });

  it('a posted reason that is not a plain token reaches the note as unknown; an ordinary one as it always did', () => {
    const plain = deps(false);
    expect(decideAction(plain, twilioProvider, { callId: 'CA7', raw: {}, handoffData: '{"reasonCode":"live-agent"}' }).note).toBe('dial:live-agent');
    expect(decideAction(plain, twilioProvider, { callId: 'CA8', raw: {}, handoffData: '{"reasonCode":"max-attempts"}' }).note).toBe('dial:max-attempts');
    const forged = decideAction(plain, twilioProvider, { callId: 'CA9', raw: {}, handoffData: JSON.stringify({ reasonCode: 'live-agent\r\nforged' }) });
    expect(forged.note).toBe('dial:unknown');
    expect(forged.document).toContain(`<Dial>${HANDOFF}</Dial>`);
    expect(decideAction(deps(true), twilioProvider, { callId: 'CA10', raw: {}, handoffData: JSON.stringify({ reasonCode: 'live-agent\nforged', target: 'CALLBACK_DESK' }) }).note).toBe('dial:unknown to CALLBACK_DESK');
  });

  it('an app without transfer dials HANDOFF_NUMBER as before, its note unchanged', () => {
    const d = deps(false);
    const r = decideAction(d, twilioProvider, { callId: 'CA3', raw: {}, handoffData: JSON.stringify({ reasonCode: 'live-agent', target: 'PRIORITY_LINE', headers: { 'X-Queue': 'p' } }) });
    expect(r).toEqual({ document: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${HANDOFF}</Dial></Response>`, note: 'dial:live-agent' });
  });

  it('a call put through with no decision (gave up after reconnects) goes to the default', () => {
    const d = { ...deps(true), transfer: transferTargetsFrom(callbackApp, { ...ENV, MAIN_LINE: 'sip:main@pbx.example.com' }, HANDOFF) };
    d.store.create('CA4', { send: () => {}, close: () => {} });
    const r = decideAction(d, twilioProvider, { callId: 'CA4', raw: {}, callStatus: 'in-progress', live: true, sessionStatus: 'failed' });
    expect(r.note).toBe('gave-up');
    expect(r.document).toContain('<Dial><Sip>sip:main@pbx.example.com</Sip></Dial>');
  });

  it('a saved call the server cannot read, whose socket ended it with no target, goes to the default', () => {
    // server/adapter.ts ends such a call with endFrame('unreadable'), which names no target; its callback dials the default.
    const d = deps(true);
    const r = decideAction(d, twilioProvider, { callId: 'CA5', raw: {}, handoffData: '{"reasonCode":"unreadable"}' });
    expect(r.document).toContain(`<Dial>${ENV.MAIN_LINE}</Dial>`);
    expect(r.note).toBe('dial:unreadable to MAIN_LINE');
  });
});

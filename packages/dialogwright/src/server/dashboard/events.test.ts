import { describe, expect, it } from 'vitest';
import { redactRecord, redactFrameLine } from './events';
import { setupFrame } from '../../testing/relayFrames';
import { speechEvent } from '../../channel/events';
import { frameToEvent } from '../../channel/relay/map';
import type { TraceRecord } from '../../trace/types';
import type { FrameLogLine } from '../frameLog';
import { useTestkit } from '../../testing/apps';

useTestkit();

function baseRecord(event: TraceRecord['event']): TraceRecord {
  return {
    v: 2,
    sessionId: 's',
    turnIndex: 1,
    ts: '2026-09-21T00:00:00.000Z',
    event,
    turnState: null,
    questions: null,
    answers: null,
    source: 'none',
    error: null,
    gates: [],
    decision: { kind: 'prompt', promptId: 'ask_intent', vars: {}, acks: [], target: 'intent', options: [] } as TraceRecord['decision'],
    actions: [],
    form: null,
    slots: {} as TraceRecord['slots'],
    timing: { planMs: 0, askMs: 0, resolveMs: 0, totalMs: 0 },
    usage: { inputTokens: 0, outputTokens: 0, estimated: true, costUsd: 0 },
  };
}

/** Twilio's own shapes: 34 characters, `AC`/`CA` plus 32 hex. */
const ACCOUNT_SID = 'ACa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';
const CALL_SID = 'CAf6e5d4c3b2a1f6e5d4c3b2a1f6e5d4';
/** A whole number in any of the spellings the route used to pass through. */
const WHOLE_NUMBER = /\+?1?\d{10}/;

describe('redactRecord', () => {
  it('masks from/to on a setup event', () => {
    const record = baseRecord(frameToEvent(setupFrame('s')));
    const redacted = redactRecord(record);
    expect(redacted.event).toMatchObject({ type: 'session.start', provider: { from: '…0001', to: '…0002' } });
  });

  it('masks the optional identity fields of a setup event and drops the geo lookup', () => {
    const record = baseRecord(frameToEvent({
      ...setupFrame('s'),
      callSid: CALL_SID,
      accountSid: ACCOUNT_SID,
      forwardedFrom: '+15550001111',
      callerName: 'Jane Roe',
      callStatus: 'in-progress',
      customParameters: { from: '+15555550199', token: 't' },
    }));
    const event = redactRecord(record).event as unknown as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'session.start',
      provider: {
        from: '…0001',
        to: '…0002',
        forwardedFrom: '…1111',
        callerName: 'redacted',
        callSid: CALL_SID,
        callStatus: 'in-progress',
        'param.from': '…0199',
        'param.token': 'redacted',
      },
    });
    expect(event.provider).not.toHaveProperty('accountSid');
    expect(JSON.stringify(event)).not.toMatch(WHOLE_NUMBER);
    expect(JSON.stringify(event)).not.toContain(ACCOUNT_SID);
  });

  it('masks every custom parameter of a session start, whatever its name', () => {
    const provider = { sessionId: 's', 'param.token': 'secret-token', 'param.AccountRef': 'A-123', 'param.from': '+15555550199' };
    const redacted = redactRecord(baseRecord({ type: 'session.start', provider })).event as unknown as { provider: Record<string, string> };
    expect(redacted.provider).toEqual({ sessionId: 's', 'param.token': 'redacted', 'param.AccountRef': 'redacted', 'param.from': '…0199' });
  });

  it('returns other records unchanged', () => {
    const record = baseRecord(speechEvent('hello', true));
    expect(redactRecord(record)).toEqual(record);
  });

  it('leaves turnState in place', () => {
    // `turnState` ends in `State`, which is also the suffix of Twilio's geo fields: the record's
    // own bookkeeping must not be collateral damage.
    const record = { ...baseRecord(speechEvent('hi')), turnState: { mode: 'ask' } as unknown as TraceRecord['turnState'] };
    expect(redactRecord(record).turnState).toEqual({ mode: 'ask' });
  });
});

describe('redactRecord identity slots', () => {
  it('masks the account ID to its last four and the date of birth to its year, and keeps the statement for the console', () => {
    const slots = {
      ...baseRecord(speechEvent('hi')).slots,
      accountId: { value: '55501234', display: '5550 1234', confirmed: true, attempts: 0, window: null, helped: [] },
      dob: { value: '1985-04-12', display: 'April 12th, 1985', confirmed: true, attempts: 0, window: null, helped: [] },
      missingNote: { value: 'a box of books', display: 'your description', confirmed: true, attempts: 0, window: null, helped: [] },
    } as TraceRecord['slots'];
    const r = redactRecord({ ...baseRecord(speechEvent('hi')), slots });
    expect(r.slots.accountId).toMatchObject({ value: '...1234', display: '...1234' });
    expect(r.slots.dob).toMatchObject({ value: '••/••/1985', display: '••/••/1985' });
    expect(r.slots.missingNote!.value).toBe('a box of books');
  });
});

describe('redactFrameLine', () => {
  it('masks the identity slots in an end frame\'s handoff data', () => {
    const line = { ts: 't', dir: 'out' as const, msg: { type: 'end', handoffData: JSON.stringify({ reasonCode: 'identity', slots: { accountId: '5550 1234', dob: 'April 12th, 1985' } }) } };
    const msg = redactFrameLine(line).msg as { handoffData: string };
    expect(JSON.parse(msg.handoffData)).toEqual({ reasonCode: 'identity', slots: { accountId: '...1234', dob: '••/••/1985' } });
  });

  it('masks from/to on a setup frame line and leaves other lines unchanged', () => {
    const setupLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: setupFrame('s') };
    expect(redactFrameLine(setupLine).msg).toMatchObject({ type: 'setup', from: '…0001', to: '…0002' });

    const otherLine: FrameLogLine = { ts: '2026-09-21T00:00:00.000Z', dir: 'in', msg: { type: 'dtmf', digit: '1' } };
    expect(redactFrameLine(otherLine)).toEqual(otherLine);
  });

  it('redacts a whole frame log by key, whatever the dir and whether or not the line has a type', () => {
    const setupLine: FrameLogLine = {
      ts: '2026-09-21T00:00:00.000Z',
      dir: 'in',
      msg: {
        type: 'setup',
        sessionId: 'VX1',
        callSid: CALL_SID,
        from: '+15555550199',
        to: '+15550000002',
        forwardedFrom: '+15550001111',
        accountSid: ACCOUNT_SID,
        callerName: 'Jane Roe',
        customParameters: { from: '+15555550199' },
      },
    };
    // What http.ts writes for the action webhook: the raw form post, with no `type` at all.
    const actionLine: FrameLogLine = {
      ts: '2026-09-21T00:00:01.000Z',
      dir: 'http',
      msg: {
        route: '/cr-action',
        From: '+15555550199',
        To: '+15550000002',
        Caller: '+15555550199',
        Called: '+15550000002',
        FromCity: 'PORTLAND',
        FromState: 'OR',
        FromZip: '97204',
        FromCountry: 'US',
        AccountSid: ACCOUNT_SID,
        CallSid: CALL_SID,
        CallStatus: 'completed',
        SessionStatus: 'ended',
      },
    };
    const logLine: FrameLogLine = { ts: '2026-09-21T00:00:02.000Z', dir: 'log', msg: { noInputArmedMs: 4000, socketClosed: true } };

    const redacted = [setupLine, actionLine, logLine].map(redactFrameLine);
    const json = JSON.stringify(redacted);
    // Nothing anywhere in the payload is still a whole number or an account id.
    expect(json).not.toMatch(WHOLE_NUMBER);
    expect(json).not.toMatch(/AC[0-9a-f]{32}/);
    expect(json).not.toContain('Jane Roe');
    expect(json).not.toContain('PORTLAND');
    expect(json).not.toContain('97204');

    expect(redacted[0]!.msg).toMatchObject({
      type: 'setup',
      from: '…0199',
      to: '…0002',
      forwardedFrom: '…1111',
      callerName: 'redacted',
      customParameters: { from: '…0199' },
    });
    expect(redacted[0]!.msg).not.toHaveProperty('accountSid');

    // The call's own identifiers and statuses are what the page is for: they survive.
    expect(redacted[1]!.msg).toMatchObject({
      route: '/cr-action',
      From: '…0199',
      To: '…0002',
      Caller: '…0199',
      Called: '…0002',
      CallSid: CALL_SID,
      CallStatus: 'completed',
      SessionStatus: 'ended',
    });
    for (const key of ['AccountSid', 'FromCity', 'FromState', 'FromZip', 'FromCountry']) {
      expect(redacted[1]!.msg).not.toHaveProperty(key);
    }
    // A log line carries no identity at all and comes back exactly as written.
    expect(redacted[2]).toEqual(logLine);
  });
});

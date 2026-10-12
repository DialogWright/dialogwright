import { describe, expect, it } from 'vitest';
import { scripted, FROM } from '../../testing/scripted';
import {
  alertCount, alertsRaised, callRow, callsQuery, configure, dayBoundMs, durationText, HANDED_OFF_SHOWN_MS, isAlert, liveList, liveStrip,
  pageTitle, STATUS_TEXT, withMeta, formLabel, type CallRow,
} from './view.js';
import { consoleMetaOf, type ConsoleMeta } from './meta';
import { testkitApp } from '../../testing/testkit';
import { useTestkit } from '../../testing/apps';
import type { DashboardEvent } from './events';

/**
 * The console's lists (view.js callRow and the Live list's helpers): one call as a row of the Live
 * list, from the events the bus already carries, in the app's words; its status (on track, a second
 * try, frustrated, transferring, with a person); how it ended; and the list, its strip, its alerts and
 * the Calls page's query.
 */

useTestkit();
const META = consoleMetaOf(testkitApp);
configure(META);

const OPENER = 'a parcel is missing, it was a small box left at the back door';
const ACCOUNT_ID = 'five five five zero one two three four';

const ended = (reason: 'completed' | 'hangup' | 'handoff' | 'error' | 'abandoned', at = 60_000): DashboardEvent => ({ type: 'ended', callSid: 'CA1', at, reason });

describe('callRow: one call as the Live list shows it', () => {
  it('on track at the start: the task and the step in the app\'s words, the caller masked, the time and the cost', async () => {
    const { events } = await scripted([OPENER], { startMs: 1_000 });
    expect(callRow(events)).toMatchObject({
      callSid: 'CA1', app: null, from: FROM, channel: 'voice', startedAt: 1_000, lastAt: 6_000, endedAt: null, turns: 2,
      task: { form: 'report_missing', label: 'Report a missing parcel' }, step: 'Account ID',
      tasks: [{ id: 'report_missing', label: 'Report a missing parcel' }], status: 'on-track', frustrated: false, ending: null,
    });
    expect(callRow(events).costUsd).toBeGreaterThan(0);
  });

  it('a second try: the slot it asks is past its first attempt', async () => {
    const { events } = await scripted([OPENER, 'banana']);
    expect(callRow(events)).toMatchObject({ status: 'second-try', step: 'Account ID' });
    // The step a turn later, the slot filled: on track again.
    const { events: on } = await scripted([OPENER, 'banana', ACCOUNT_ID]);
    expect(callRow(on).status).toBe('on-track');
  });

  it('frustrated once the frustration gate fires, and it stays so for the call', async () => {
    const { events } = await scripted([OPENER, 'this is ridiculous, I already told you']);
    expect(callRow(events)).toMatchObject({ status: 'frustrated', frustrated: true });
    const { events: later } = await scripted([OPENER, 'this is ridiculous, I already told you', ACCOUNT_ID]);
    expect(callRow(later)).toMatchObject({ status: 'frustrated', frustrated: true });
  });

  it('transferring once a handoff is decided, then with a person once it ended so, and how it ended', async () => {
    const { events } = await scripted([OPENER, 'let me talk to a person']);
    expect(callRow(events)).toMatchObject({ status: 'transferring', handoffReason: 'live-agent', ending: null });
    const row = callRow([...events, ended('handoff')]);
    expect(row).toMatchObject({ status: 'with-person', endedAt: 60_000, ending: { kind: 'person', reason: 'live-agent', text: 'to a person · caller asked for a person' } });
  });

  it('says where a caller hung up: the task and the step, or the greeting', async () => {
    const { events } = await scripted([OPENER]);
    expect(callRow([...events, ended('hangup')]).ending).toEqual({ kind: 'hangup', where: 'Report a missing parcel · Account ID', text: 'hung up at Report a missing parcel · Account ID' });
    const { events: greeted } = await scripted([]);
    expect(callRow([...greeted, ended('hangup')]).ending).toMatchObject({ kind: 'hangup', where: 'the greeting' });
    expect(callRow([...greeted, ended('abandoned')]).ending).toMatchObject({ kind: 'hangup', text: 'left at the greeting' });
    expect(callRow([...events, ended('completed')]).ending).toEqual({ kind: 'handled', text: 'handled' });
    expect(callRow([...events, ended('error')])).toMatchObject({ status: 'ended', ending: { kind: 'error' } });
  });

  it('is live again after a hangup a reconnect followed, as the detail view reads it', async () => {
    const { events } = await scripted([OPENER]);
    const back = callRow([...events, ended('hangup'), { type: 'reconnect', callSid: 'CA1', at: 61_000, attempt: 1 }]);
    expect(back).toMatchObject({ endedAt: null, ending: null, status: 'on-track' });
  });

  it('never carries a value the caller gave: only what was asked', async () => {
    const { events } = await scripted([OPENER, ACCOUNT_ID]);
    const text = JSON.stringify(callRow(events));
    expect(text).not.toMatch(/5550|1234|back door/);
    expect(text).not.toContain('+1555');
  });

  it('reads each call in its own app\'s words (withMeta), and puts back the words in force', async () => {
    const { events } = await scripted([OPENER]);
    const other: ConsoleMeta = { ...META, formLabels: { report_missing: 'Lost parcel' }, slotLabels: { accountId: 'customer number' } };
    expect(callRow(events, { meta: other })).toMatchObject({ task: { label: 'Lost parcel' }, step: 'customer number' });
    expect(formLabel('report_missing')).toBe('Report a missing parcel');
    expect(withMeta(other, () => formLabel('report_missing'))).toBe('Lost parcel');
    expect(withMeta(null, () => formLabel('report_missing'))).toBe('Report a missing parcel');
  });

  it('names a host call\'s app, and a chat\'s caller, as call_started says them', () => {
    const row = callRow([{ type: 'call_started', callSid: 'W1', at: 5, from: 'web chat', todayIso: '2026-09-18', thresholds: {}, channel: 'chat', caller: 'Pat', app: 'routed' }]);
    expect(row).toMatchObject({ app: 'routed', from: 'web chat', channel: 'chat', caller: 'Pat', provider: null, status: 'on-track', step: null });
  });
});

const row = (over: Partial<CallRow>): CallRow => ({
  callSid: 'CA1', app: null, from: '…0110', caller: null, channel: 'voice', provider: 'twilio', startedAt: 0, lastAt: 0, endedAt: null, turns: 1,
  task: { form: null, label: null }, step: null, tasks: [], status: 'on-track', frustrated: false, handoffReason: null, ending: null, costUsd: 0, ...over,
});

describe('the Live list', () => {
  const now = 1_000_000;
  const rows = [
    row({ callSid: 'A', startedAt: 10 }),
    row({ callSid: 'B', startedAt: 5, status: 'second-try' }),
    row({ callSid: 'C', startedAt: 20, status: 'frustrated', app: 'routed' }),
    row({ callSid: 'D', startedAt: 1, status: 'with-person', endedAt: now - 10_000 }),
    row({ callSid: 'E', startedAt: 1, status: 'with-person', endedAt: now - HANDED_OFF_SHOWN_MS - 1 }),
    row({ callSid: 'F', startedAt: 1, status: 'ended', endedAt: now - 1 }),
  ];

  it('shows the calls in progress and those handed off a moment ago, alerts first, then the longest-running', () => {
    expect(liveList(rows, now, null).map((r) => r.callSid)).toEqual(['D', 'C', 'B', 'A']);
    expect(liveList(rows, now, 'routed').map((r) => r.callSid)).toEqual(['C']);
  });

  it('counts the strip and the alerts', () => {
    const shown = liveList(rows, now, null);
    expect(liveStrip(shown)).toEqual({ inProgress: 3, waiting: 1 });
    expect(alertCount(shown)).toBe(2);
    expect(isAlert(row({ status: 'transferring' }))).toBe(true);
    expect(isAlert(row({ status: 'second-try' }))).toBe(false);
    expect(STATUS_TEXT['with-person']).toBe('with a person');
  });

  it('raises an alert on a change into frustrated or waiting, never for what the page found on opening', () => {
    const first = alertsRaised(null, [row({ callSid: 'A', status: 'frustrated' })]);
    expect(first.raised).toEqual([]);
    const next = alertsRaised(first.statuses, [row({ callSid: 'A', status: 'transferring' }), row({ callSid: 'B', status: 'frustrated' }), row({ callSid: 'C' })]);
    expect(next.raised).toEqual(['B']);
    expect(alertsRaised(next.statuses, [row({ callSid: 'C', status: 'transferring' })]).raised).toEqual(['C']);
  });

  it('titles the page with the alert count', () => {
    expect(pageTitle('Live', 2, 'Example')).toBe('(2) Live · Example console');
    expect(pageTitle('Calls', 0, 'Example')).toBe('Calls · Example console');
  });

  it('reads durations as a clock', () => {
    expect(durationText(42_000)).toBe('0:42');
    expect(durationText(725_000)).toBe('12:05');
    expect(durationText(3_723_000)).toBe('1:02:03');
    expect(durationText(-5)).toBe('0:00');
  });
});

describe('the Calls page\'s query', () => {
  it('keeps only what is well formed', () => {
    expect(callsQuery({ last4: '01-10', ending: 'hangup', task: 'report_missing', app: 'routed', page: 2 })).toBe('last4=0110&app=routed&task=report_missing&ending=hangup&page=2');
    expect(callsQuery({ last4: '123', ending: 'sideways', page: -1 })).toBe('');
    const from = dayBoundMs('2026-10-12', false)!;
    const to = dayBoundMs('2026-10-12', true)!;
    expect(to - from + 1).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(new Date(from).getHours()).toBe(0);
    expect(callsQuery({ from: '2026-10-12', to: '2026-10-12' })).toBe(`from=${from}&to=${to}`);
    expect(dayBoundMs('yesterday', false)).toBeNull();
  });
});

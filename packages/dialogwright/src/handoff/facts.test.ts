import { describe, expect, it } from 'vitest';
import type { AuditDraft, AuditEntry } from '../audit/types';
import { composeNote, handoffFacts as factsIn } from './facts';
import { TESTKIT_HANDOFF } from '../testing/testkit/domain/present';

/** The facts in the testkit's words (App.handoff), as its calls' handoff notes read them. */
const handoffFacts = (entries: readonly AuditEntry[]) => factsIn(entries, TESTKIT_HANDOFF);

let seq = 0;
function e(d: AuditDraft): AuditEntry {
  seq++;
  return { ...d, seq, at: '2026-09-26T12:00:00.000Z', callId: 'CA-test-1', channel: 'voice', prevHash: '0'.repeat(64), hash: String(seq).padStart(64, '0') };
}

// The shape of a dry-run call: a track, a report filed, then another customer's parcel,
// an injection attempt, and a request for a person.
const CALL: AuditEntry[] = [
  e({ type: 'call_started', detail: { channel: 'voice', principal: 'anonymous', level: 0 } }),
  e({ type: 'identity', detail: { factor: 'account_id_dob', pass: true, level: 1 } }),
  e({ type: 'identity', detail: { factor: 'one_time_code', pass: true, level: 2 } }),
  e({ type: 'report_created', detail: { report: '9130', customer: '...1234' } }),
  e({ type: 'gate', detail: { tool: 'getParcel', call: 'getParcel(parcel=7201)', purpose: null, verdict: 'BLOCK', reason: 'scope', needLevel: null, rules: ['R2 fail: parcel owner ...5678 · caller may see ...1234 only'] } }),
  e({ type: 'screen_fired', detail: { hits: 1, value: 0.95 } }),
  e({ type: 'handoff', detail: { reason: 'live-agent', completed: ['track_parcel', 'delivery_window', 'report_missing'], queued: [] } }),
];

describe('handoffFacts', () => {
  it('reads the identity level, every refusal, injection attempts, filed reports and the handoff reason', () => {
    expect(handoffFacts(CALL)).toEqual({
      identity: 'level 2 (account ID, date of birth and a one-time code)',
      blocked: ["getParcel(parcel=7201): not one of the caller's own parcels"],
      manipulationAttempts: 1,
      codesSpoken: 0,
      handoffReason: 'the caller asked for a person',
      completed: ['track_parcel', 'delivery_window', 'report_missing'],
      reportsFiled: ['9130'],
    });
  });

  it('words a signed-in delegate refusal for the delegate, and starts the delegate at its own identity line', () => {
    const f = handoffFacts([
      e({ type: 'call_started', detail: { channel: 'chat', principal: 'agent', level: 2 } }),
      e({ type: 'gate', detail: { tool: 'getParcel', call: 'getParcel(parcel=7301)', verdict: 'BLOCK', reason: 'scope' } }),
    ]);
    expect(f.identity).toBe('depot staff signed in (level 2)');
    expect(f.blocked).toEqual(["getParcel(parcel=7301): not a customer of the caller's depot"]);
  });

  it('puts a code said aloud on the Blocked line, counted, and never loses it to the model', () => {
    const f = handoffFacts([
      e({ type: 'call_started', detail: { channel: 'voice', principal: 'anonymous', level: 0 } }),
      e({ type: 'identity', detail: { factor: 'account_id_dob', pass: true, level: 1 } }),
      e({ type: 'code_spoken', detail: { masked: true, reissued: true } }),
      e({ type: 'code_spoken', detail: { masked: true, reissued: true } }),
    ]);
    expect(f.codesSpoken).toBe(2);
    expect(composeNote(f, 'Blocked: none')).toContain('Blocked: one-time code said aloud, not accepted; a new code was sent (2 times)');
  });

  it('reports an unverified caller with nothing blocked', () => {
    expect(handoffFacts([e({ type: 'call_started', detail: { principal: 'anonymous' } })])).toMatchObject({ identity: 'not verified', blocked: [], manipulationAttempts: 0 });
  });
});

describe('composeNote', () => {
  const facts = handoffFacts(CALL);

  it('puts the facts in Identity and Blocked whatever the model said, and the model in the rest', () => {
    const model = 'Wanted: the status of his neighbour\'s parcel, then a person\nDone: window answer, parcel 7101 status, filed report 9130\nBlocked: None\nNext: explain the pickup form';
    expect(composeNote(facts, model)).toBe([
      'Identity: level 2 (account ID, date of birth and a one-time code)',
      "Wanted: the status of his neighbour's parcel, then a person",
      'Done: window answer, parcel 7101 status, filed report 9130',
      "Blocked: getParcel(parcel=7201): not one of the caller's own parcels; attempt to manipulate the assistant detected",
      'Next: explain the pickup form',
    ].join('\n'));
  });

  it('splits labels the model ran together on one line', () => {
    const note = composeNote(facts, 'Wanted: a person Done: filed report 9130 Next: offer the pickup form');
    expect(note.split('\n')).toEqual([
      'Identity: level 2 (account ID, date of birth and a one-time code)',
      'Wanted: a person',
      'Done: filed report 9130',
      "Blocked: getParcel(parcel=7201): not one of the caller's own parcels; attempt to manipulate the assistant detected",
      'Next: offer the pickup form',
    ]);
  });

  it('falls back to facts when the model leaves a line out', () => {
    const note = composeNote(facts, 'The caller wanted help.');
    expect(note).toContain('Wanted: not stated');
    expect(note).toContain('Done: completed track_parcel, delivery_window, report_missing');
    expect(note).toContain('Next: transferred because the caller asked for a person');
  });

  it('collapses a refusal asked for twice into one entry with a count', () => {
    const twice = handoffFacts([...CALL.slice(0, 5), CALL[4]!, ...CALL.slice(5)]);
    expect(composeNote(twice, 'Wanted: a person')).toContain("Blocked: getParcel(parcel=7201): not one of the caller's own parcels (2 times); attempt to manipulate the assistant detected");
  });
});

describe('handoffFacts, with no app wording', () => {
  it('words the levels, refusals and reasons neutrally, and lists no created records', () => {
    const f = factsIn([...CALL, e({ type: 'gate', detail: { tool: 'x', call: 'x(a=1)', verdict: 'BLOCK', reason: 'delivered' } })]);
    expect(f).toEqual({
      identity: 'level 2',
      blocked: ["getParcel(parcel=7201): not in the caller's scope", 'x(a=1): delivered'],
      manipulationAttempts: 1,
      codesSpoken: 0,
      handoffReason: 'the caller asked for a person',
      completed: ['track_parcel', 'delivery_window', 'report_missing'],
    });
    // A principal kind the app does not word as signed in starts nowhere special.
    expect(factsIn([e({ type: 'call_started', detail: { channel: 'chat', principal: 'agent', level: 2 } })]).identity).toBe('not verified');
    expect(factsIn([e({ type: 'handoff', detail: { reason: 'role-person', completed: [] } })]).handoffReason).toBe('role-person');
  });
});

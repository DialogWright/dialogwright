import { describe, expect, it } from 'vitest';
import { diff, differingIds, gapsNowMatching, knownGapsFor } from './regressDiff';
import type { CorpusEntry } from '../jev/corpus';

describe('diff', () => {
  it('reports an id only in expected as removed', () => {
    expect(diff('corpus', { a: { v: 1 } }, {})).toEqual({ lines: ['- corpus a: removed'], matching: 0, allowed: [], gapped: [] });
  });

  it('reports an id only in actual as new', () => {
    expect(diff('corpus', {}, { a: { v: 1 } })).toEqual({ lines: ['+ corpus a: new'], matching: 0, allowed: [], gapped: [] });
  });

  it('reports one line per changed key', () => {
    expect(diff('corpus', { a: { v: 'a' } }, { a: { v: 'b' } })).toEqual({
      lines: ['~ corpus a.v: "a" -> "b"'],
      matching: 0,
      allowed: [],
      gapped: [],
    });
  });

  it('counts an identical entry as matching and emits no line', () => {
    expect(diff('corpus', { a: { v: 1 } }, { a: { v: 1 } })).toEqual({ lines: [], matching: 1, allowed: [], gapped: [] });
  });

  it('reports decidedGate/verdict drift on an allowed id apart, and still fails every other key', () => {
    const e = { s: { decision: 'handoff', decidedGate: 'wantsHuman', verdict: 'handoff' } };
    const a = { s: { decision: 'handoff', decidedGate: 'confirmation', verdict: 'confirmed' } };
    expect(diff('scenario', e, a, new Set(['s']))).toEqual({
      lines: [],
      matching: 0,
      allowed: [
        '~ scenario s.decidedGate: "wantsHuman" -> "confirmation" (allowed: cosmeticDrift)',
        '~ scenario s.verdict: "handoff" -> "confirmed" (allowed: cosmeticDrift)',
      ],
      gapped: [],
    });
    // Not allowed: the same drift is an ordinary diff line.
    expect(diff('scenario', e, a).lines).toHaveLength(2);
    // Allowed, but the decision itself moved: that still fails.
    const moved = { s: { ...a.s, decision: 'prompt' } };
    expect(diff('scenario', e, moved, new Set(['s'])).lines).toEqual(['~ scenario s.decision: "handoff" -> "prompt"']);
  });

  it('allows a known-gap id that shows exactly its pinned outcome, each key with its reason, and names it as gapped', () => {
    const e = { g: { decision: 'handoff', promptId: 'a', gate: null }, h: { v: 1 } };
    const a = { g: { decision: 'prompt', promptId: 'b', gate: null }, h: { v: 2 } };
    const gaps = new Map([['g', { reason: 'the model reads it differently', outcome: { decision: 'prompt', promptId: 'b' } }]]);
    expect(diff('corpus', e, a, new Set(), gaps)).toEqual({
      lines: ['~ corpus h.v: 1 -> 2'],
      matching: 0,
      allowed: [
        '~ corpus g.decision: "handoff" -> "prompt" (allowed: knownGap: the model reads it differently)',
        '~ corpus g.promptId: "a" -> "b" (allowed: knownGap: the model reads it differently)',
      ],
      gapped: ['g'],
    });
    // Without the gap, the same difference fails.
    expect(diff('corpus', e, a).lines).toHaveLength(3);
  });

  it('fails a known-gap id whose outcome drifts beyond its pin (a different gate), naming what the pin expected', () => {
    const e = { g: { decision: 'prompt', promptId: 'a', gate: 'listOpenings:ALLOW' } };
    const gaps = new Map([['g', { reason: 'r', outcome: { promptId: 'b' } }]]);
    // The pinned drift, and a gate that also moved (to a write tool): not the known outcome, so it fails.
    const beyond = { g: { decision: 'prompt', promptId: 'b', gate: 'bookAppointment:ALLOW' } };
    expect(diff('corpus', e, beyond, new Set(), gaps)).toEqual({
      lines: [
        '~ corpus g.promptId: "a" -> "b" (knownGap pins "b")',
        '~ corpus g.gate: "listOpenings:ALLOW" -> "bookAppointment:ALLOW"',
      ],
      matching: 0,
      allowed: [],
      gapped: [],
    });
    // A pinned field that moved somewhere else than the pin says fails too.
    const elsewhere = { g: { decision: 'prompt', promptId: 'c', gate: 'listOpenings:ALLOW' } };
    expect(diff('corpus', e, elsewhere, new Set(), gaps).lines).toEqual(['~ corpus g.promptId: "a" -> "c" (knownGap pins "b")']);
    // Only part of the pinned outcome shows: still not the known outcome.
    const two = new Map([['g', { reason: 'r', outcome: { promptId: 'b', gate: null } }]]);
    expect(diff('corpus', e, { g: { ...e.g, promptId: 'b' } }, new Set(), two).lines).toEqual(['~ corpus g.promptId: "a" -> "b" (knownGap pins "b")']);
  });

  it('allows a gap with a few outcomes when any one of them shows, and fails one that shows none, naming every pinned value', () => {
    const base: { decision: string; promptId: string; gate: string | null } = { decision: 'prompt', promptId: 'a', gate: null };
    const e = { g: base };
    const gaps = new Map([['g', { reason: 'a borderline line', outcomes: [{ promptId: 'b' }, { promptId: 'c', gate: 'listOpenings:ALLOW' }] }]]);
    // The first outcome.
    expect(diff('corpus', e, { g: { ...base, promptId: 'b' } }, new Set(), gaps)).toEqual({
      lines: [],
      matching: 0,
      allowed: ['~ corpus g.promptId: "a" -> "b" (allowed: knownGap: a borderline line)'],
      gapped: ['g'],
    });
    // The second, both of its fields.
    expect(diff('corpus', e, { g: { ...base, promptId: 'c', gate: 'listOpenings:ALLOW' } }, new Set(), gaps)).toEqual({
      lines: [],
      matching: 0,
      allowed: [
        '~ corpus g.promptId: "a" -> "c" (allowed: knownGap: a borderline line)',
        '~ corpus g.gate: null -> "listOpenings:ALLOW" (allowed: knownGap: a borderline line)',
      ],
      gapped: ['g'],
    });
    // A mix of the two is neither outcome, and fails; so does a third value.
    expect(diff('corpus', e, { g: { ...base, promptId: 'b', gate: 'listOpenings:ALLOW' } }, new Set(), gaps).lines).toEqual([
      '~ corpus g.promptId: "a" -> "b" (knownGap pins "b" or "c")',
      '~ corpus g.gate: null -> "listOpenings:ALLOW" (knownGap pins "listOpenings:ALLOW")',
    ]);
    expect(diff('corpus', e, { g: { ...base, promptId: 'd' } }, new Set(), gaps).lines).toEqual(['~ corpus g.promptId: "a" -> "d" (knownGap pins "b" or "c")']);
    // The baseline itself: matching, and the tag may be removable.
    expect(diff('corpus', e, e, new Set(), gaps)).toEqual({ lines: [], matching: 1, allowed: [], gapped: [] });
    expect(gapsNowMatching(e, e, gaps)).toEqual(['g']);
  });

  it('compares a pinned object by value, whatever order its keys were written in', () => {
    const e: Record<string, { slots: Record<string, string | null> }> = { g: { slots: { name: 'ann', dob: '1975-06-14' } } };
    const a = { g: { slots: { name: null, dob: '1975-06-14' } } };
    const gaps = new Map([['g', { reason: 'r', outcome: { slots: { dob: '1975-06-14', name: null } } }]]);
    expect(diff('corpus', e, a, new Set(), gaps as never).gapped).toEqual(['g']);
  });

  it('counts a known-gap id that matches as matching, not gapped; a gap never hides a removed or new id', () => {
    const gaps = new Map([['g', { reason: 'r', outcome: { v: 2 } as never }]]);
    expect(diff('corpus', { g: { v: 1 } }, { g: { v: 1 } }, new Set(), gaps)).toEqual({ lines: [], matching: 1, allowed: [], gapped: [] });
    expect(diff('corpus', { g: { v: 1 } }, {}, new Set(), gaps).lines).toEqual(['- corpus g: removed']);
    expect(diff('corpus', {}, { g: { v: 1 } }, new Set(), gaps).lines).toEqual(['+ corpus g: new']);
  });
});

describe('gapsNowMatching', () => {
  it('names a gap whose outcome matches the baseline exactly, and not one that shows its gap or fails', () => {
    const gaps = new Map([
      ['now', { reason: 'r', outcome: { promptId: 'b' } }],
      ['shows', { reason: 'r', outcome: { promptId: 'b' } }],
      ['fails', { reason: 'r', outcome: { promptId: 'b' } }],
      ['gone', { reason: 'r', outcome: { promptId: 'b' } }],
    ]);
    const e = { now: { promptId: 'a' }, shows: { promptId: 'a' }, fails: { promptId: 'a' }, gone: { promptId: 'a' } };
    const a = { now: { promptId: 'a' }, shows: { promptId: 'b' }, fails: { promptId: 'c' } };
    expect(gapsNowMatching(e, a, gaps)).toEqual(['now']);
  });
});

describe('knownGapsFor', () => {
  const corpus = [
    { id: 'g', text: 'x', intent: 'none', context: 'no_form', knownGap: { reason: 'r', outcome: { promptId: 'b' } } },
    { id: 'h', text: 'y', intent: 'none', context: 'no_form' },
  ] as unknown as CorpusEntry[];

  it("gives a real model's runs (live, record, recorded) every entry's gap", () => {
    for (const kind of ['jev', 'record', 'recorded']) expect([...knownGapsFor(kind, corpus).keys()], kind).toEqual(['g']);
  });

  it('gives the stubs (fixture and heuristic) none: they are held to the baseline exactly', () => {
    for (const kind of ['stub', 'heuristic']) expect(knownGapsFor(kind, corpus).size, kind).toBe(0);
    // So the gap's own drift fails a stub run.
    const e = { g: { promptId: 'a' } };
    const a = { g: { promptId: 'b' } };
    expect(diff('corpus', e, a, new Set(), knownGapsFor('stub', corpus)).lines).toEqual(['~ corpus g.promptId: "a" -> "b"']);
    expect(diff('corpus', e, a, new Set(), knownGapsFor('recorded', corpus)).lines).toEqual([]);
  });
});

describe('differingIds', () => {
  it('names each id with a difference that fails, once, and not one whose differences are allowed or that matches', () => {
    const e = { same: { v: 1 }, two: { v: 1, w: 1 }, gap: { v: 1 }, drift: { decidedGate: 'a', v: 1 }, gone: { v: 1 } };
    const a = { same: { v: 1 }, two: { v: 2, w: 2 }, gap: { v: 2 }, drift: { decidedGate: 'b', v: 1 }, fresh: { v: 1 } };
    const gaps = new Map([['gap', { reason: 'r', outcome: { v: 2 } as never }]]);
    expect(differingIds('x', e, a, new Set(['drift']), gaps)).toEqual(['two', 'gone', 'fresh']);
    expect(differingIds('x', e, a)).toEqual(['two', 'gap', 'drift', 'gone', 'fresh']);
  });
});

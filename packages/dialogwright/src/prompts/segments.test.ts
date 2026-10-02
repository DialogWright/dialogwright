import { describe, expect, it } from 'vitest';
import manifest from '../testing/testkit/prompts/manifest.json';
import { joinSpoken, seamViolations as seamViolationsOf, segmentTemplate, segmentsOf, ttsOnly as ttsOnlyOf, type Segment } from './segments';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import { renderTemplate } from './render';

useTestkit();

// The testkit's spoken and data variables (App.prompts), and the two checks as an app runs them.
const SPOKEN_VARS: ReadonlySet<string> = new Set(testkitApp.prompts.spokenVars);
const DATA_VARS: ReadonlySet<string> = new Set(testkitApp.prompts.dataVars);
const ttsOnly = (segments: readonly Segment[]): boolean => ttsOnlyOf(testkitApp, segments);
const seamViolations = (promptId: string, segments: Segment[]): string[] => seamViolationsOf(testkitApp, promptId, segments);

describe('segmentTemplate', () => {
  it('splits fixed runs and variables in order, numbering fixed segments', () => {
    expect(segmentTemplate('p', 'Thanks, {first}.')).toEqual([
      { kind: 'fixed', id: 'p.0', text: 'Thanks,' },
      { kind: 'var', name: 'first' },
      { kind: 'fixed', id: 'p.1', text: '.' },
    ]);
  });
  it('handles leading, trailing, and adjacent variables and drops empty runs', () => {
    expect(segmentTemplate('q', '{first}\'s parcel')).toEqual([
      { kind: 'var', name: 'first' },
      { kind: 'fixed', id: 'q.0', text: '\'s parcel' },
    ]);
    expect(segmentTemplate('r', '{a}{b}')).toEqual([{ kind: 'var', name: 'a' }, { kind: 'var', name: 'b' }]);
    expect(segmentTemplate('s', 'Goodbye.')).toEqual([{ kind: 'fixed', id: 's.0', text: 'Goodbye.' }]);
  });
  it('drops a whitespace-only run between adjacent variables', () => {
    expect(segmentTemplate('r', '{a} {b}')).toEqual(segmentTemplate('r', '{a}{b}'));
  });
  it('leaves non-placeholder braces as fixed text', () => {
    expect(segmentTemplate('t', 'A {} b { x } c {a}.')).toEqual([
      { kind: 'fixed', id: 't.0', text: 'A {} b { x } c' },
      { kind: 'var', name: 'a' },
      { kind: 'fixed', id: 't.1', text: '.' },
    ]);
  });
});

describe('SPOKEN_VARS', () => {
  it('includes the identity factors and the report readback values, but not a vocabulary variable', () => {
    for (const name of ['accountId', 'dob', 'expectedDate', 'report', 'parcel', 'day']) expect(SPOKEN_VARS.has(name), name).toBe(true);
    expect(SPOKEN_VARS.has('part')).toBe(false);
  });
});

describe('joinSpoken', () => {
  it('joins pieces with a single space, no space before punctuation, and skips empty pieces', () => {
    expect(joinSpoken(['Thanks,', 'Alex', '.'])).toBe('Thanks, Alex.');
    expect(joinSpoken(['due', 'September 15', ', and I have'])).toBe('due September 15, and I have');
    expect(joinSpoken(['a', '', 'b'])).toBe('a b');
  });
  it('reproduces renderTemplate for every manifest template, given the same vars', () => {
    const vars: Record<string, string> = {
      intentLabel: 'track a parcel',
      first: 'Alex',
      a: 'track a parcel',
      b: 'report a missing parcel',
      phoneLast4: '0101',
      parcel: '7101',
      item: 'a box of books',
      day: 'Monday',
      part: 'in the morning',
      expectedDate: 'September 15',
      report: '1001',
      days: '3',
    };
    const lookup = (name: string): string => {
      const v = vars[name];
      if (v === undefined) throw new Error(`test vars missing ${name}`);
      return v;
    };
    for (const [id, entry] of Object.entries(manifest)) {
      const segs = segmentTemplate(id, entry.text);
      const joined = joinSpoken(segs.map((s) => (s.kind === 'fixed' ? s.text : lookup(s.name))));
      expect(joined).toBe(renderTemplate(entry.text, vars));
    }
  });
});

describe('seamViolations', () => {
  it('requires a spoken variable to be followed by punctuation or the end', () => {
    expect(seamViolations('x', segmentTemplate('x', 'Due {expectedDate}.'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Account ID {accountId}'))).toEqual([]);
    expect(seamViolations('x', segmentTemplate('x', 'Due {expectedDate} and still missing.'))).toEqual(['x: {expectedDate} must be followed by punctuation or end the prompt']);
    expect(seamViolations('x', segmentTemplate('x', 'Delivering {part} on Monday.'))).toEqual([]);
  });
  it('holds across the whole manifest', () => {
    const all = segmentsOf(manifest);
    const violations = Object.entries(all).flatMap(([id, segs]) => seamViolations(id, segs));
    expect(violations).toEqual([]);
    expect(all.greeting_chat_delegate).toEqual([
      { kind: 'fixed', id: 'greeting_chat_delegate.0', text: 'Hi' },
      { kind: 'var', name: 'first' },
      { kind: 'fixed', id: 'greeting_chat_delegate.1', text: ", I'm the Example Parcels assistant for depot staff. I can look up a customer's parcel. What do you need?" },
    ]);

    // Every variable name in the manifest is a spoken (TTS-only) var subject to the seam rule,
    // a vocabulary var (one the app records clips for, or `first`, a name: a fixed set of display
    // values, though none is recorded), or a data var whose line is spoken whole by TTS. A typo like
    // {acountId} would silently land in none of them and escape the seam rule, so pin the
    // vocabulary too.
    const VOCAB_VARS = new Set([...(testkitApp.prompts.vocabulary ?? []).flatMap((v) => v.vars), 'first']);
    const varNames = new Set<string>();
    for (const segs of Object.values(all)) {
      for (const s of segs) {
        if (s.kind === 'var') varNames.add(s.name);
      }
    }
    expect(varNames.size).toBeGreaterThan(0);
    for (const name of varNames) {
      expect(SPOKEN_VARS.has(name) || VOCAB_VARS.has(name) || DATA_VARS.has(name), name).toBe(true);
    }
    // The three sets are disjoint: a variable is one kind of thing.
    for (const name of DATA_VARS) expect(SPOKEN_VARS.has(name) || VOCAB_VARS.has(name), name).toBe(false);
  });

  it('speaks a line that carries data whole by TTS, and only such a line', () => {
    const all = segmentsOf(manifest);
    for (const id of ['parcel_status_in_transit', 'parcel_status_delivered', 'depot_result']) expect(ttsOnly(all[id as keyof typeof all]), id).toBe(true);
    for (const id of ['confirm_report', 'report_filed', 'ask_otp', 'identity_verified', 'greeting']) expect(ttsOnly(all[id as keyof typeof all]), id).toBe(false);
    // So the seam rule has nothing to say about it: its {day} and {parcel} are not seams.
    expect(seamViolations('parcel_status_in_transit', all.parcel_status_in_transit)).toEqual([]);
  });

  it('attaches a possessive to the name before it', () => {
    expect(joinSpoken(['Alex R.', "'s parcel"])).toBe("Alex R.'s parcel");
  });
});

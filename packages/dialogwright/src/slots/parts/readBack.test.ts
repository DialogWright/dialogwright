import { describe, expect, it } from 'vitest';
import { formatProblem } from '../../define/problems';
import { buildSlot, defineSlot, slotTypeJsonSchema } from '../defineSlot';
import { BUILT_IN_SLOT_TYPES } from '../registry';

/**
 * `confirm: always` on every library slot type (slots.yaml): a value read back for a yes as soon as
 * it is heard, and a no that empties the slot and asks it again (SlotSpec.readBackNo `ask`). The
 * default stays as each type had it, so a slot that does not write it is built as before.
 */

/** Each type, by a configuration it builds from, the read-back a choice slot has tested in its own file. */
const TYPES: Record<string, Record<string, unknown>> = {
  text: { type: 'text', what: 'a note for the visit', say: null, redact: 'none' },
  name: { type: 'name' },
  record: { type: 'record' },
  topic: { type: 'topic' },
  birthdate: { type: 'birthdate' },
  digits: { type: 'digits', noun: 'account', length: 8 },
  date: { type: 'date', range: 'future' },
};

describe('confirm: always, on every type', () => {
  for (const [type, config] of Object.entries(TYPES)) {
    it(`${type}: reads back, declares confirm_<slot>, and asks again on a no; without it, as before`, () => {
      const read = defineSlot('s', { ...config, confirm: 'always' });
      expect(read).toMatchObject({ spokenConfirm: 'always', readBackNo: 'ask' });
      expect(read.prompts).toContainEqual({ id: 'confirm_s', why: 'it reads a value back for a yes as soon as it is heard (confirm: always)', vars: ['s'] });
      const plain = defineSlot('s', config);
      expect(plain.spokenConfirm).toBe('summary');
      expect(plain).not.toHaveProperty('readBackNo');
      expect(plain.prompts!.map((p) => p.id)).not.toContain('confirm_s');
    });
  }

  it('refuses a mode a type does not have, and readBack that has no effect with always', () => {
    const problems = (config: Record<string, unknown>): string[] => {
      const r = buildSlot('s', config);
      return r.ok ? [] : r.problems.map(formatProblem);
    };
    expect(problems({ ...TYPES.text, confirm: 'by-confidence' })).toHaveLength(1);
    expect(problems({ ...TYPES.digits, confirm: 'always', readBack: 'none' })).toEqual([
      '(code)  s.readBack  readBack "none" has no effect with confirm "always", which reads every spoken number back for a yes  ->  set confirm: by-confidence, or delete readBack',
    ]);
    expect(problems({ ...TYPES.date, confirm: 'always', readBack: 'below-fill' })).toHaveLength(1);
  });
});

describe('what confirm: always says', () => {
  const said = (type: string): string => {
    const t = BUILT_IN_SLOT_TYPES[type]!;
    return ((slotTypeJsonSchema(t).properties as Record<string, { description?: string }>).confirm?.description) ?? '';
  };

  it('names the keypad question only for a type that takes keys', () => {
    for (const type of ['name', 'text', 'topic']) expect(said(type), type).not.toContain('ask_<slot>_dtmf');
    for (const type of ['choice', 'digits', 'date', 'birthdate', 'record']) expect(said(type), type).toContain('ask_<slot>_dtmf');
  });
});

describe('a text slot read back by a stand-in', () => {
  it('is refused: the caller would hear "your description?", nothing they could correct', () => {
    const r = buildSlot('note', { type: 'text', what: 'a note', confirm: 'always' });
    expect(r.ok ? [] : r.problems.map(formatProblem)).toEqual([
      '(code)  note.confirm  confirm "always" reads the slot back by its display, which is the stand-in "your description", so the caller hears nothing they could correct  ->  set say: null (with redact: none) to read the words back as said, or delete confirm',
    ]);
    expect(buildSlot('note', { type: 'text', what: 'a note', say: null, redact: 'none', confirm: 'always' }).ok).toBe(true);
  });
});

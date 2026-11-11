import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPersonas } from './personas';

const write = (yaml: string): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'personas-')), 'personas.yaml');
  writeFileSync(f, yaml);
  return f;
};

describe('loadPersonas', () => {
  it('loads a valid file', () => {
    const ps = loadPersonas(write(`personas:
  - id: terse-caller
    goal: Ask the opening hours.
    truth: { name: Pat Example }
    manner: Terse.
    expects: answer
  - id: human-check
    goal: Leave a note.
    truth: { name: Sam Sample }
    manner: Polite.
    expects: callback
    asksIfHuman: true
`));
    expect(ps.map((p) => p.id)).toEqual(['terse-caller', 'human-check']);
    expect(ps[1]!.asksIfHuman).toBe(true);
  });

  it('refuses a persona without truth, naming its id', () => {
    expect(() => loadPersonas(write(`personas:
  - id: no-truth
    goal: Ask something.
    manner: Plain.
    expects: answer
`))).toThrow(/persona no-truth: truth/);
  });

  it('refuses an id used twice', () => {
    const one = `    goal: g\n    truth: { a: b }\n    manner: m\n    expects: none\n`;
    expect(() => loadPersonas(write(`personas:\n  - id: same\n${one}  - id: same\n${one}`))).toThrow(/persona same: id is used twice/);
  });

  it('takes the number a persona calls from, E.164 only', () => {
    const one = (from: string): string => `personas:\n  - id: regular\n    goal: Book in.\n    truth: { name: Pat Example }\n    manner: Quick.\n    expects: booking\n    callingFrom: "${from}"\n`;
    expect(loadPersonas(write(one('+15555550142')))[0]!.callingFrom).toBe('+15555550142');
    expect(() => loadPersonas(write(one('555 555 0142')))).toThrow(/persona regular: callingFrom/);
  });
});

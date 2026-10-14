import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { MESSAGE_DIR, messageCode } from '../testing/message/app';

/**
 * What `check` says of a text slot's `others: { listen: [...] }` (live findings item 27): each slot it
 * lets listen at its dictation is a slot of a form that holds it, never the slot itself; any other is
 * refused with its fix, positioned in slots.yaml like every other problem.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The message fixture with `others` on its message slot. */
function withOthers(others: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-others-'));
  scratch.push(dir);
  cpSync(MESSAGE_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  const slots = join(dir, 'slots.yaml');
  const text = readFileSync(slots, 'utf8');
  if (!text.includes('  maxLength: 400\n')) throw new Error('the message slot changed');
  writeFileSync(slots, text.replace('  maxLength: 400\n', `  maxLength: 400\n  others: ${others}\n`));
  return dir;
}

async function problems(dir: string): Promise<string[]> {
  return (await checkAppFully(dir, { code: messageCode, fixturesRoot: PACKAGE_DIR })).problems.map(formatProblem);
}

describe("a text slot's others: { listen }", () => {
  it('passes with a slot of the form that holds it, and with quiet or listen', async () => {
    expect(await problems(withOthers('{ listen: [recipient] }'))).toEqual([]);
    expect(await problems(withOthers('quiet'))).toEqual([]);
    expect(await problems(withOthers('listen'))).toEqual([]);
  });

  it('refuses a slot no form holding it has, and the slot itself, with the fix', async () => {
    const [missing, ...rest] = await problems(withOthers('{ listen: [urgency] }'));
    expect(rest).toEqual([]);
    expect(missing).toContain('slots.yaml:31:22  message.others.listen[0]');
    expect(missing).toContain('the slot "message" lets "urgency" listen while it takes the caller\'s words (others: listen), but "urgency" is not a slot of a form that holds "message" (take_message)');
    expect(missing).toContain('->  name one of "recipient", "caller", "phone", or take "urgency" out of the list');
    const [itself] = await problems(withOthers('{ listen: [recipient, message] }'));
    expect(itself).toContain('message.others.listen[1]');
    expect(itself).toContain('but "message" is the slot itself');
  });

  it('refuses an empty list and a value that is not one of the forms', async () => {
    expect((await problems(withOthers('{ listen: [] }'))).join('\n')).toContain('must name at least one slot');
    expect((await problems(withOthers('sometimes'))).length).toBeGreaterThan(0);
  });
});

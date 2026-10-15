import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { MESSAGE_DIR, messageCode } from '../testing/message/app';

/**
 * What `check` says of a text slot's `commands: { listen: [...] }` (live findings item 29): each intent
 * it still acts on at its question is an intent of intents.yaml; any other is refused with its fix,
 * positioned in slots.yaml like every other problem.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** The message fixture with `commands` on its message slot. */
function withCommands(commands: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-commands-'));
  scratch.push(dir);
  cpSync(MESSAGE_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  const slots = join(dir, 'slots.yaml');
  const text = readFileSync(slots, 'utf8');
  if (!text.includes('  maxLength: 400\n')) throw new Error('the message slot changed');
  writeFileSync(slots, text.replace('  maxLength: 400\n', `  maxLength: 400\n  commands: ${commands}\n`));
  return dir;
}

async function problems(dir: string): Promise<string[]> {
  return (await checkAppFully(dir, { code: messageCode, fixturesRoot: PACKAGE_DIR })).problems.map(formatProblem);
}

describe("a text slot's commands: { listen }", () => {
  it('passes with intents of intents.yaml, and with ignore or listen', async () => {
    expect(await problems(withCommands('{ listen: [agent, repeat_prompt] }'))).toEqual([]);
    expect(await problems(withCommands('ignore'))).toEqual([]);
    expect(await problems(withCommands('listen'))).toEqual([]);
  });

  it('refuses an id that is no intent, with the fix and the intent it may have meant', async () => {
    const [missing, ...rest] = await problems(withCommands('{ listen: [agent, agnet, urgent] }'));
    expect(missing).toContain('slots.yaml:31:31  message.commands.listen[1]');
    expect(missing).toContain('the slot "message" acts on "agnet" while it takes the caller\'s words (commands: listen), but "agnet" is not an intent in intents.yaml');
    expect(missing).toContain('->  rename it to "agent", or name one of "take_message", "agent", "repeat_prompt", "done", "other", "none", or take "agnet" out of the list');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toContain('message.commands.listen[2]');
    expect(rest[0]).toContain('"urgent" is not an intent in intents.yaml');
  });

  it('refuses an empty list and a value that is not one of the forms', async () => {
    expect((await problems(withCommands('{ listen: [] }'))).join('\n')).toContain('must name at least one intent');
    expect((await problems(withCommands('sometimes'))).length).toBeGreaterThan(0);
  });
});

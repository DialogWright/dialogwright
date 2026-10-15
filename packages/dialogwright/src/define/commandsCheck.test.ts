import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { MESSAGE_DIR, messageCode } from '../testing/message/app';
import { SCREENED_DIR, screenedCode } from '../testing/screened/app';

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

/** The screened fixture (its `urgent` intent is a priority intent) with a free-text slot asked last in the booking, `commands` as given. */
function screenedWithDetails(commands?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-commands-'));
  scratch.push(dir);
  cpSync(SCREENED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  const edit = (file: string, from: string, to: string): void => {
    const text = readFileSync(join(dir, file), 'utf8');
    if (!text.includes(from)) throw new Error(`${file} changed`);
    writeFileSync(join(dir, file), text.replace(from, to));
  };
  writeFileSync(join(dir, 'slots.yaml'), `${readFileSync(join(dir, 'slots.yaml'), 'utf8')}details:\n  type: text\n  what: the details of the problem\n${commands !== undefined ? `  commands: ${commands}\n` : ''}`);
  edit('forms.yaml', 'slots: [problem, ownership, town, howUrgent, visitDay, timeOfDay]', 'slots: [problem, ownership, town, howUrgent, visitDay, timeOfDay, details]');
  edit('prompts.yaml', '  ask_timeOfDay:\n', '  ask_details:\n    text: Tell me what is happening.\n    interruptible: true\n  ask_details_retry:\n    text: Sorry, tell me what is happening.\n    interruptible: true\n  ask_timeOfDay:\n');
  return dir;
}

describe('a priority intent a dictation does not hear: a warning, never a refusal', () => {
  const result = async (commands?: string) => {
    const r = await checkAppFully(screenedWithDetails(commands), { code: screenedCode, fixturesRoot: PACKAGE_DIR });
    return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem).filter((w) => w.includes('details')) };
  };

  it('warns of a text slot without pick that says no commands, in an app with a priority intent, with the fix', async () => {
    const { problems, warnings } = await result();
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('details  the turn at the question of "details" is its words, whole (commands: ignore, the default for a text slot without pick), so the priority intent "urgent" said there is read back as the words, never acted on');
    expect(warnings[0]).toContain('->  add "commands: { listen: [urgent, agent] }" to hear it (and a request for a person) there, or "commands: ignore" if that is meant');
  });

  it('is quiet once the slot says commands, either way', async () => {
    expect((await result('ignore')).warnings).toEqual([]);
    expect((await result('{ listen: [urgent, agent] }')).warnings).toEqual([]);
    expect((await result('listen')).warnings).toEqual([]);
  });
});

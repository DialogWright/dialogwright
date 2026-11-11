import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from '../../define/check';
import { formatProblem } from '../../define/problems';
import { CALLBACK_DIR, callbackCode } from '../../testing/callback/app';

/**
 * `pnpm check` and agent.yaml: a converse app's folder (app.yaml's mode: converse) has its agent.yaml
 * validated with its app.yaml; a scripted app's folder with none is unchanged (one with an agent.yaml is
 * refused: define/converseCheck.test.ts).
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'agent.yaml');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function problemsOf(agent: string | null): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-agent-'));
  scratch.push(dir);
  if (agent === null) {
    cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
    return (await checkAppFully(dir, { code: callbackCode, fixturesRoot: PACKAGE_DIR })).problems.map(formatProblem);
  }
  writeFileSync(join(dir, 'app.yaml'), '# yaml-language-server: $schema=../schemas/app.schema.json\nid: example\nmode: converse\n');
  writeFileSync(join(dir, 'agent.yaml'), agent);
  return (await checkAppFully(dir)).problems.map(formatProblem);
}

describe('pnpm check and agent.yaml', () => {
  const text = readFileSync(FIXTURE, 'utf8');

  it('an app with no agent.yaml is unchanged', async () => {
    expect(await problemsOf(null)).toEqual([]);
  });

  it('a valid agent.yaml adds no problem', async () => {
    expect(await problemsOf(text)).toEqual([]);
  });

  it('a file without the schema line is refused, with the line to write', async () => {
    const out = await problemsOf(text.split('\n').slice(1).join('\n'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^agent\.yaml:1:1  \(file\)  agent\.yaml does not start with the schema line .*->  make the first line "# yaml-language-server: \$schema=.*agent\.schema\.json"/);
  });

  it('a mistake is printed at its line with a path and a fix', async () => {
    const out = await problemsOf(text.replace('then: [notify]', 'then: [nothing]'));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^agent\.yaml:\d+:\d+  actions\.book\.then\[0\]  "nothing" is no action .*->  /);
  });
});

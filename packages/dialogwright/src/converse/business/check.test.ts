import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from '../../define/check';
import { formatProblem } from '../../define/problems';
import { CALLBACK_DIR, callbackCode } from '../../testing/callback/app';

/** `pnpm check` on an app folder that holds an agent.yaml: it is validated where there is one, and only there. */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixture', 'agent.yaml');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function problemsOf(agent: string | null): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-agent-'));
  scratch.push(dir);
  cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  if (agent !== null) writeFileSync(join(dir, 'agent.yaml'), agent);
  const r = await checkAppFully(dir, { code: callbackCode, fixturesRoot: PACKAGE_DIR });
  return r.problems.map(formatProblem);
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

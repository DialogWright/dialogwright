import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkApp } from './check';
import { defineApp } from './defineApp';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';

/** `pnpm check` on a converse app's folder: its app.yaml (mode: converse) and its agent.yaml, read together. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-check-'));
  dirs.push(d);
  for (const f of ['app.yaml', 'agent.yaml']) copyFileSync(join(CONVERSE_FIXTURE_DIR, f), join(d, f));
  return d;
}

const lines = (problems: { file: string; line: number; path: string; message: string }[]): string[] => problems.map((p) => `${p.file}:${p.line} ${p.path} ${p.message}`);

describe('pnpm check on a converse app', () => {
  it('passes app.yaml and agent.yaml that are each valid', async () => {
    expect(await checkApp(folder())).toEqual([]);
  });

  it('refuses a scripted file beside them, and a missing agent.yaml', async () => {
    const d = folder();
    writeFileSync(join(d, 'intents.yaml'), 'intents: {}\n');
    expect(lines(await checkApp(d))).toEqual([expect.stringContaining('intents.yaml:1 (file) intents.yaml is not read by a converse app')]);
    rmSync(join(d, 'intents.yaml'));
    rmSync(join(d, 'agent.yaml'));
    expect(lines(await checkApp(d))).toEqual([expect.stringContaining('agent.yaml:1 (file) agent.yaml is missing')]);
  });

  it('refuses what the business\'s gate cannot hold, at its line in agent.yaml', async () => {
    const d = folder();
    const text = readFileSync(join(d, 'agent.yaml'), 'utf8').replace('    audit: { name: length, phone: last4 }', '    rules:\n      - oneOf: { field: colour, values: [red], reason: not-offered }\n    audit: { name: length, phone: last4 }');
    writeFileSync(join(d, 'agent.yaml'), text);
    const found = await checkApp(d);
    expect(lines(found)).toEqual([expect.stringMatching(/^agent\.yaml:\d+ actions\.book\.rules\[0\]\.oneOf\.field "colour" is no param of "book"/)]);
    expect(found[0]!.line).toBe(text.split('\n').findIndex((l) => l.includes('colour')) + 1);
  });

  it('is not an app defineApp builds', () => {
    expect(() => defineApp(folder(), {} as never)).toThrow(/app\.yaml says mode: converse, so the app is built with defineConverseApp/);
  });

  it('refuses agent.yaml beside an app that is not converse', async () => {
    const d = folder();
    writeFileSync(join(d, 'app.yaml'), readFileSync(join(d, 'app.yaml'), 'utf8').replace('mode: converse\n', 'mode: scripted\n').replace(/chat:\n  callerNumberFromContext: true\n/, ''));
    expect(lines(await checkApp(d))).toContainEqual(expect.stringContaining('agent.yaml:1 (file) agent.yaml is read only by a converse app'));
  });
});

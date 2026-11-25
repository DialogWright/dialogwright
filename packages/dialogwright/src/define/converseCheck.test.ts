import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkApp } from './check';
import { defineApp } from './defineApp';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';

/** `pnpm check` on an agent app's folder: its app.yaml (mode: agent) and its agent.yaml, read together. */

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

describe('pnpm check on an agent app', () => {
  it('passes app.yaml and agent.yaml that are each valid', async () => {
    expect(await checkApp(folder())).toEqual([]);
  });

  it('mode: agent loads an agent.yaml app', async () => {
    const d = folder();
    expect(readFileSync(join(d, 'app.yaml'), 'utf8')).toMatch(/^mode: agent$/m);
    expect(await checkApp(d)).toEqual([]);
  });

  it('mode: converse is refused with the fix "write mode: agent", whatever else the folder holds', async () => {
    const d = folder();
    writeFileSync(join(d, 'app.yaml'), readFileSync(join(d, 'app.yaml'), 'utf8').replace('mode: agent\n', 'mode: converse\n'));
    const found = await checkApp(d);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'app.yaml', path: 'mode', fix: 'write mode: agent' });
    expect(found[0]!.message).toContain('"mode: converse"');
    // Alone, with no agent.yaml beside it, the name is still the one problem.
    rmSync(join(d, 'agent.yaml'));
    expect(lines(await checkApp(d))).toEqual([expect.stringContaining('app.yaml:')]);
    expect((await checkApp(d)).map((p) => p.fix)).toEqual(['write mode: agent']);
  });

  it('an app folder with a business.yaml and no agent.yaml is still refused as the old agent mode', async () => {
    const d = folder();
    rmSync(join(d, 'agent.yaml'));
    writeFileSync(join(d, 'business.yaml'), 'business: {}\n');
    const found = await checkApp(d);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'business.yaml', fix: expect.stringContaining('the old agent mode was removed') });
  });

  it('refuses a scripted file beside them, and a missing agent.yaml', async () => {
    const d = folder();
    writeFileSync(join(d, 'intents.yaml'), 'intents: {}\n');
    expect(lines(await checkApp(d))).toEqual([expect.stringContaining('intents.yaml:1 (file) intents.yaml is not read by an agent app')]);
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

  it('refuses a style.yaml beside them, as it is not read', async () => {
    const d = folder();
    writeFileSync(join(d, 'style.yaml'), 'model: { provider: inception, id: mercury-3 }\n');
    expect(lines(await checkApp(d))).toEqual([expect.stringContaining('style.yaml:1 (file) style.yaml is not read by an agent app')]);
  });

  it('says only what is wrong with an app.yaml its schema refuses, guessing no mode from an agent.yaml beside it', async () => {
    const d = folder();
    writeFileSync(join(d, 'app.yaml'), 'id: converse\nmode: agent\nchat:\n  callerNumberFromContext: sometimes\n');
    // Neither a scripted file nor a broken agent.yaml is read while app.yaml does not say what the folder is.
    writeFileSync(join(d, 'intents.yaml'), 'intents: {}\n');
    writeFileSync(join(d, 'agent.yaml'), readFileSync(join(d, 'agent.yaml'), 'utf8').replace('business:', 'businesses:'));
    const found = lines(await checkApp(d));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^app\.yaml:4 chat\.callerNumberFromContext /);
  });

  it('is not an app defineApp builds', () => {
    expect(() => defineApp(folder(), {} as never)).toThrow(/app\.yaml says mode: agent, so the app is built with defineConverseApp/);
  });

  it('refuses agent.yaml beside an app that is not converse', async () => {
    const d = folder();
    writeFileSync(join(d, 'app.yaml'), readFileSync(join(d, 'app.yaml'), 'utf8').replace('mode: agent\n', 'mode: scripted\n').replace(/chat:\n  callerNumberFromContext: true\n/, ''));
    expect(lines(await checkApp(d))).toContainEqual(expect.stringContaining('agent.yaml:1 (file) agent.yaml is read only by an agent app'));
  });
});

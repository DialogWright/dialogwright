import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { RECOGNIZED_DIR, recognizedCode } from '../testing/recognized/app';

/**
 * What `check` says of a short secret: a library `digits` slot that can be four digits or fewer
 * (its `length`, or a `mask` that lets it), redacted by its last four (`redact: last4`, the default),
 * which would be all of it. The engine records such a value as bullets (••••) anyway; the warning
 * points to `redact: length`, and never refuses: the app decides.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the recognized fixture's YAML (an eight-digit account number and a date of birth as the factors), each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-short-'));
  scratch.push(dir);
  cpSync(RECOGNIZED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code: recognizedCode, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

const EIGHT = '  length: 8\n  group: [4, 4]\n  keypad: true\n';
/** The account number as a four-digit factor, with `extra` lines beside it. */
const short = (extra = '') => ({ 'slots.yaml': replace(EIGHT, `  length: 4\n  keypad: true\n${extra}`) });

describe('a short secret', () => {
  it('warns of a factor of four digits redacted by its last four, the default, pointing to redact: length', async () => {
    const { problems, warnings } = await checked(folder(short()));
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('slots.yaml');
    expect(warnings[0]).toContain('the slot "accountId" is an identity factor of 4 digits or fewer (length: 4), and redact: last4 shows a value by its last four digits, which would be all of it, so it is recorded as bullets (••••)');
    expect(warnings[0]).toContain('set "redact: length" to record it by its length (<4 chars>), or ask a longer number; nothing to do if bullets are meant');
  });

  it('warns of it when last4 is written out, and of a slot whose mask lets it be four digits or fewer', async () => {
    expect((await checked(folder(short('  redact: last4\n')))).warnings).toHaveLength(1);
    const masked = await checked(folder({ 'slots.yaml': replace(EIGHT, '  mask: "\\\\d{4,8}"\n') }));
    expect(masked.problems).toEqual([]);
    expect(masked.warnings).toHaveLength(1);
    expect(masked.warnings[0]).toContain('the slot "accountId" is an identity factor of 4 digits or fewer (mask: \\d{4,8})');
  });

  it('warns of a slot that is no factor too', async () => {
    const { warnings } = await checked(folder({ 'slots.yaml': (text) => `${text}pin:\n  type: digits\n  noun: PIN\n  length: 4\n` }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('the slot "pin" can be 4 digits or fewer (length: 4)');
  });

  it('says nothing of a short slot by its length or not redacted, nor of a longer one', async () => {
    expect((await checked(folder(short('  redact: length\n')))).warnings).toEqual([]);
    expect((await checked(folder(short('  redact: none\n  handoff: display\n')))).warnings).toEqual([]);
    expect((await checked(folder({ 'slots.yaml': replace(EIGHT, '  length: 5\n  keypad: true\n') }))).warnings).toEqual([]);
    expect((await checked(folder({ 'slots.yaml': replace(EIGHT, '  mask: "5\\\\d{7}"\n') }))).warnings).toEqual([]);
    expect((await checked(folder())).warnings).toEqual([]);
  });
});

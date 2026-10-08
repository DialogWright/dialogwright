import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import type { AppCode } from './defineApp';
import { TEXTING_DIR, textingCode } from '../testing/texting/app';
import { YES_NO } from '../testing/texting/variant';
import { PROPOSALS_DIR, proposalsCode } from '../testing/proposals/app';

/**
 * What `check` says of the answers an offer takes (design 2026-10-08-offer-answers-and-consent, item
 * 1): `callerNumber.answers` and `offerAnswers` take `yes-no-or-value` or `yes-no`, and `offerAnswers`
 * needs `offer: facts`.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of a fixture's YAML, each file changed by its function. */
function folder(from: string, files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-offer-check-'));
  scratch.push(dir);
  cpSync(from, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the answers an offer takes', () => {
  it('callerNumber.answers: yes-no passes check, and a value it does not have is refused', async () => {
    expect(await checked(folder(TEXTING_DIR, YES_NO), textingCode)).toEqual({ problems: [], warnings: [] });
    const { problems } = await checked(folder(TEXTING_DIR, { 'slots.yaml': replace('    ifNone: skip\n', '    ifNone: skip\n    answers: digits\n') }), textingCode);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('textTo.callerNumber.answers');
  });

  it('offerAnswers passes check beside offer: facts, and takes yes-no-or-value or yes-no only', async () => {
    for (const answers of ['yes-no', 'yes-no-or-value']) {
      expect(await checked(folder(PROPOSALS_DIR, { 'slots.yaml': replace('  offer: facts\n', `  offer: facts\n  offerAnswers: ${answers}\n`) }), proposalsCode), answers).toEqual({ problems: [], warnings: [] });
    }
    const { problems } = await checked(folder(PROPOSALS_DIR, { 'slots.yaml': replace('  offer: facts\n', '  offer: facts\n  offerAnswers: maybe\n') }), proposalsCode);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('place.offerAnswers');
  });

  it('offerAnswers needs offer: facts; on the caller\'s number\'s offer it is callerNumber.answers', async () => {
    const none = await checked(folder(PROPOSALS_DIR, { 'slots.yaml': replace('  offer: facts\n', '  offerAnswers: yes-no\n') }), proposalsCode);
    expect(none.problems.join('\n')).toContain('the slot "place" says offerAnswers: "yes-no", but it proposes nothing (it has no offer: facts)');
    expect(none.problems.join('\n')).toContain('add "offer: facts", or delete "offerAnswers"');
    const caller = await checked(folder(TEXTING_DIR, { 'slots.yaml': replace("  callerNumber:\n", "  offerAnswers: yes-no\n  callerNumber:\n") }), textingCode);
    expect(caller.problems).toHaveLength(1);
    expect(caller.problems[0]).toContain('the offer of the caller\'s number takes callerNumber.answers');
    expect(caller.problems[0]).toContain('move it into callerNumber as "answers: yes-no"');
  });
});

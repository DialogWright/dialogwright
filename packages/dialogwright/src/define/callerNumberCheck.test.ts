import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import type { AppCode } from './defineApp';
import { CALLBACK_DIR, callbackCode } from '../testing/callback/app';
import { defineSlot, SlotConfigError } from '../slots/defineSlot';
import { loadCorpus } from '../jev/corpus';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { callbackApp } from '../testing/callback/app';

/**
 * What `check` says of a slot that offers the number the caller is calling from (a digits slot's
 * `callerNumber`): refused on an identity factor, the offer's line required in every locale, and the
 * two warnings, which `check` prints and never counts.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML, each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-caller-'));
  scratch.push(dir);
  cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(file === 'identity.yaml' ? '' : readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode = callbackCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('passes check with no problem and no warning', async () => {
    expect(await checkAppFully(CALLBACK_DIR, { code: callbackCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });
});

describe('the option', () => {
  it('takes a country code of one to three digits, and nothing else', () => {
    const phone = { type: 'digits', noun: 'phone', length: 10 } as const;
    expect(defineSlot('phone', { ...phone, callerNumber: { countryCode: '1' } }).callerNumber).toBeDefined();
    expect(defineSlot('phone', phone).callerNumber).toBeUndefined();
    for (const bad of [{ countryCode: '' }, { countryCode: '1234' }, { countryCode: '+1' }, {}, { countryCode: '1', extra: true }]) {
      expect(() => defineSlot('phone', { ...phone, callerNumber: bad }), JSON.stringify(bad)).toThrow(SlotConfigError);
    }
  });

  it('is a digits slot\'s only: another type refuses it', () => {
    expect(() => defineSlot('reason', { type: 'choice', options: { a: 'A', b: 'B' }, callerNumber: { countryCode: '1' } })).toThrow(/callerNumber/);
  });

  it('declares its line, offer_<slot> with {last4}', () => {
    expect(defineSlot('phone', { type: 'digits', noun: 'phone', length: 10, callerNumber: { countryCode: '1' } }).prompts).toContainEqual(expect.objectContaining({ id: 'offer_phone', vars: ['last4'] }));
  });
});

describe('check', () => {
  it('needs the offer\'s line', async () => {
    const dir = folder({ 'prompts.yaml': replace("  offer_phone:\n    text: Is the number you're calling from, ending in {last4}, the best one to reach you?\n    interruptible: true\n", '') });
    const { problems } = await checked(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('offer_phone');
    expect(problems[0]).toContain('{last4}');
  });

  it('refuses a variable the offer is not given', async () => {
    const dir = folder({ 'prompts.yaml': replace('ending in {last4}', 'ending in {phone}') });
    const { problems } = await checked(dir);
    expect(problems.join('\n')).toContain('offer_phone');
    expect(problems.join('\n')).toContain('{phone}');
  });

  it('refuses the option on an identity factor, and says why', async () => {
    const dir = folder({
      'identity.yaml': () => [
        '# yaml-language-server: $schema=../../../schemas/identity.schema.json',
        'principals:',
        '  subject: customer',
        'levels:',
        '  1: { name: verified, factors: [phone], verify: verifyCaller, failedPrompt: identity_failed }',
        'attempts: 3',
        '',
      ].join('\n'),
    });
    const r = await checkAppFully(dir, { code: callbackCode, fixturesRoot: PACKAGE_DIR });
    const lines = r.problems.map(formatProblem);
    const refused = lines.find((l) => l.includes('callerNumber') && l.includes('identity factor'));
    expect(refused, lines.join('\n')).toBeDefined();
    expect(refused).toContain('slots.yaml:');
    expect(refused).toContain('a caller ID can be forged');
  });

  it('warns when the slot\'s form has no summary: a yes fills a number the caller never heard whole', async () => {
    const dir = folder({ 'forms.yaml': replace('summaryPromptId: confirm_request_callback', 'summaryPromptId: null') });
    const { problems, warnings } = await checked(dir);
    expect(problems.filter((p) => !p.includes('confirm_request_callback'))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^slots\.yaml:\d+:\d+ {2}phone\.callerNumber {2}the slot "phone" offers the number the caller is calling from, but the form "request_callback" has no summary/);
  });

  it('warns when the slot is kept for the whole call: it is offered once', async () => {
    const dir = folder({ 'slots.yaml': replace("  callerNumber:\n    countryCode: '1'\n", "  callerNumber:\n    countryCode: '1'\n  listen: call\n") });
    const { problems, warnings } = await checked(dir);
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('kept for the whole call, so it is offered once');
  });
});

describe('the corpus at the offer', () => {
  it('takes confirm in a form\'s context only where the prompted slot offers the caller\'s number', () => {
    resetAppsForTest();
    registerApp(callbackApp);
    const dir = mkdtempSync(join(tmpdir(), 'dialogwright-caller-corpus-'));
    scratch.push(dir);
    const file = join(dir, 'corpus.jsonl');
    writeFileSync(file, '{"id":"x-01","text":"yes","intent":"none","context":"request_callback","prompted":"phone","confirm":"yes"}\n');
    expect(loadCorpus(file)).toHaveLength(1);
    writeFileSync(file, '{"id":"x-02","text":"yes","intent":"none","context":"request_callback","prompted":"reason","confirm":"yes"}\n');
    expect(() => loadCorpus(file)).toThrow(/x-02: confirm needs a confirm_ or offer_transfer context, or a form context whose prompted slot offers the caller's number/);
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import type { AppCode } from './defineApp';
import { defineSlot, SlotConfigError } from '../slots/defineSlot';
import { PROPOSALS_DIR, proposalsCode } from '../testing/proposals/app';
import { GREETING, GREETING_LINES } from '../testing/proposals/variant';

/**
 * What `check` says of a slot that proposes a value from the facts (`offer: facts`): it needs
 * app.yaml's callerNumber with a lookup and the code's facts.offers, an `offer_<slot>` line that
 * says `{<slot>}` and nothing else, and it is never an identity factor nor beside callerNumber.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML, each file changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-proposals-'));
  scratch.push(dir);
  cpSync(PROPOSALS_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string, code: AppCode = proposalsCode): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('passes check with no problem and no warning', async () => {
    expect(await checkAppFully(PROPOSALS_DIR, { code: proposalsCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });
});

describe('offer: facts', () => {
  it('takes facts only', async () => {
    const { problems } = await checked(folder({ 'slots.yaml': replace('  offer: facts', '  offer: lookup') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('place.offer');
    expect(problems[0]).toContain('"facts"');
    expect(() => defineSlot('place', { type: 'text', what: 'an address', offer: 'maybe' })).toThrow(SlotConfigError);
    expect(defineSlot('place', { type: 'text', what: 'an address', offer: 'facts' }).offer).toBe('facts');
    expect(defineSlot('place', { type: 'text', what: 'an address' }).offer).toBeUndefined();
  });

  it('does not need app.yaml\'s callerNumber with a lookup: facts loaded after identity can be proposed', async () => {
    const noLookup = await checked(folder({ 'app.yaml': replace('  lookup: findAccountByPhone\n', '') }));
    expect(noLookup.problems.join('\n')).not.toContain('proposes a value from the facts');
    const noBlock = await checked(folder({ 'app.yaml': replace('callerNumber:\n  use: hint\n  lookup: findAccountByPhone\n', '') }));
    expect(noBlock.problems.join('\n')).not.toContain('proposes a value from the facts');
  });

  it('needs the code\'s facts.offers', async () => {
    const { offers: _offers, ...facts } = proposalsCode.facts!;
    const { problems } = await checked(folder(), { ...proposalsCode, facts });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the slot "place" proposes a value from the facts (offer: facts), but the code has no facts.offers');
  });

  it('needs offer_<slot>, which says {<slot>} and nothing else', async () => {
    const missing = await checked(folder({ 'prompts.yaml': replace("  offer_place:\n    text: I see an account for the number you're calling from. Is this about {place}?\n    interruptible: true\n", '') }));
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain('prompt "offer_place" is missing');
    expect(missing.problems[0]).toContain('gives it {place}');
    const unsaid = await checked(folder({ 'prompts.yaml': replace('Is this about {place}?', 'Is this about the address on file?') }));
    expect(unsaid.problems).toHaveLength(1);
    expect(unsaid.problems[0]).toContain('does not say it ({place}), so a yes would fill a value the caller never heard');
    const extra = await checked(folder({ 'prompts.yaml': replace('Is this about {place}?', 'Is this about {place}, ending in {last4}?') }));
    expect(extra.problems).toHaveLength(1);
    expect(extra.problems[0]).toContain('uses {last4}, which the engine does not give it');
  });

  it('is refused on an identity factor', async () => {
    const { problems } = await checked(folder({ 'slots.yaml': replace('  length: 8\n  group: [4, 4]\n  keypad: true\n', '  length: 8\n  group: [4, 4]\n  keypad: true\n  offer: facts\n') }));
    expect(problems.join('\n')).toContain('the slot "accountId" is an identity factor (identity.yaml), but it proposes a value from the facts (offer: facts)');
  });

  it('is refused on a slot redacted by its length, whose words are never said back', async () => {
    const { problems } = await checked(folder({ 'slots.yaml': replace('  say: null\n  redact: none\n', '  say: the address\n') }));
    expect(problems.join('\n')).toContain('the slot "place" is redacted by its length (redact: length), so its words are never said back, but it proposes a value from the facts (offer: facts)');
  });

  it('is refused beside callerNumber on one slot', async () => {
    const slots = (text: string): string => `${text}phone:\n  type: digits\n  noun: phone\n  length: 10\n  callerNumber:\n    countryCode: '1'\n  offer: facts\n`;
    const { problems } = await checked(folder({ 'slots.yaml': slots }));
    expect(problems.join('\n')).toContain('the slot "phone" offers both the number the caller is calling from (callerNumber) and a value from the facts (offer: facts)');
  });
});

describe('offerAt', () => {
  const greeting = (): string => folder(GREETING);

  it('greeting passes check with the two lines, and takes slot or greeting only', async () => {
    expect(await checked(greeting())).toEqual({ problems: [], warnings: [] });
    const { problems } = await checked(folder({ 'slots.yaml': replace('  offer: facts\n', '  offer: facts\n  offerAt: start\n') }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('place.offerAt');
    expect(defineSlot('place', { type: 'text', what: 'an address', offer: 'facts', offerAt: 'greeting' }).offerAt).toBe('greeting');
    expect(defineSlot('place', { type: 'text', what: 'an address', offer: 'facts' }).offerAt).toBeUndefined();
  });

  it('greeting needs greeting_offer and greet_after_offer; slot needs neither', async () => {
    const missing = await checked(folder({ ...GREETING, 'prompts.yaml': (t) => t }));
    expect(missing.problems).toHaveLength(2);
    expect(missing.problems.join('\n')).toContain('prompt "greeting_offer" is missing');
    expect(missing.problems.join('\n')).toContain('prompt "greet_after_offer" is missing');
    const atSlot = await checked(folder({ 'slots.yaml': replace('  offer: facts\n', '  offer: facts\n  offerAt: slot\n') }));
    expect(atSlot).toEqual({ problems: [], warnings: [] });
  });

  it('is refused without offer: facts', async () => {
    const { problems } = await checked(folder({ 'slots.yaml': replace('  offer: facts\n', '  offerAt: greeting\n'), 'prompts.yaml': (t) => `${t}${GREETING_LINES}` }));
    expect(problems.join('\n')).toContain('the slot "place" says offerAt: "greeting", but it proposes nothing (it has no offer: facts)');
  });
});


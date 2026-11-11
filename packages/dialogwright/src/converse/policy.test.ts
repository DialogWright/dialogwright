import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { confirmationHash } from '../gate/lines';
import { passed, type GateFacts } from '../gate/types';
import { agentBusinessProblems, AgentBusinessError } from './business/load';
import type { AgentBusiness } from './business/schema';
import { CALLER, confirmedFields, NO_LOOKUPS, policyOf } from './policy';

/** The gate of a converse app: agent.yaml's actions, each with its rules, and every change confirmed over all its params. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'business', 'fixture', 'agent.yaml');

/** The fixture business with an action that texts the caller, given their consent. */
const TEXT_ACTION = `  send_text:
    about: Text the caller the booking.
    kind: change
    params:
      phone: { type: phone, about: The number to text. }
      consent: { type: choice, options: ["yes", "no"], about: Whether the caller agreed to a text. }
    readBack:
      en: "A text to the number {phone}. Is that right?"
    rules:
      - oneOf: { field: consent, values: ["yes"], reason: no-consent }
`;

function business(edit: (text: string) => string = (t) => t): AgentBusiness {
  const text = edit(readFileSync(FIXTURE, 'utf8').replace('transfer:\n', `${TEXT_ACTION}transfer:\n`));
  const { value, problems } = agentBusinessProblems(text);
  if (!value) throw new Error(problems.map((p) => p.message).join('\n'));
  return value;
}

const facts = (confirmedHash: string | null = null): GateFacts => ({ attempts: 0, confirmedHash, todayIso: '2026-11-11' });

const bookParams = { day: '2026-12-01', window: 'morning', item: 'kettle', details: '', phone: '+15555550142' };

describe('policyOf', () => {
  const b = business();
  const policy = policyOf(b);
  const hashOf = (action: string, params: Record<string, string>): string => confirmationHash(params, confirmedFields(b.actions[action]!));

  it('refuses a change without the caller\'s confirmation', () => {
    const d = policy.evaluate({ tool: 'book', params: bookParams }, CALLER, facts(), NO_LOOKUPS);
    expect(d.verdict).toBe('BLOCK');
    expect(passed(d, 'confirmed')).toBe(false);
    expect(d.reason).toBe('confirmation');
  });

  it('allows a change whose confirmed hash is the hash of exactly its params', () => {
    const d = policy.evaluate({ tool: 'book', params: bookParams }, CALLER, facts(hashOf('book', bookParams)), NO_LOOKUPS);
    expect(d.verdict).toBe('ALLOW');
    expect(passed(d, 'confirmed')).toBe(true);
  });

  it('refuses a change confirmed with other values', () => {
    const d = policy.evaluate({ tool: 'book', params: { ...bookParams, item: 'lamp' } }, CALLER, facts(hashOf('book', bookParams)), NO_LOOKUPS);
    expect(d.verdict).toBe('BLOCK');
    expect(passed(d, 'confirmed')).toBe(false);
  });

  it('confirms over all the params, the optional ones included', () => {
    expect(confirmedFields(b.actions.book!)).toEqual(['day', 'window', 'item', 'details', 'phone']);
  });

  it('runs the confirmation last, after the action\'s own rules', () => {
    const d = policy.evaluate({ tool: 'book', params: bookParams }, CALLER, facts(), NO_LOOKUPS);
    expect(d.rules.map((r) => r.id)).toEqual(['oneOf', 'confirmed']);
  });

  it('needs no confirmation for a lookup', () => {
    const d = policy.evaluate({ tool: 'availability', params: { day: '2026-12-01' } }, CALLER, facts(), NO_LOOKUPS);
    expect(d.verdict).toBe('ALLOW');
    expect(d.rules).toEqual([]);
  });

  it('refuses by an action\'s own rule as the scripted policy does', () => {
    const yes = { phone: '+15555550142', consent: 'yes' };
    const no = { phone: '+15555550142', consent: 'no' };
    const refused = policy.evaluate({ tool: 'send_text', params: no }, CALLER, facts(hashOf('send_text', no)), NO_LOOKUPS);
    expect(refused.verdict).toBe('BLOCK');
    expect(refused.reason).toBe('no-consent');
    expect(passed(refused, 'oneOf')).toBe(false);
    const allowed = policy.evaluate({ tool: 'send_text', params: yes }, CALLER, facts(hashOf('send_text', yes)), NO_LOOKUPS);
    expect(allowed.verdict).toBe('ALLOW');
    expect(passed(allowed, 'oneOf')).toBe(true);
  });

  it('refuses an action agent.yaml does not list', () => {
    const d = policy.evaluate({ tool: 'cancel', params: {} }, CALLER, facts(), NO_LOOKUPS);
    expect(d.verdict).toBe('BLOCK');
    expect(d.reason).toBe('unknown-tool');
  });

  it('decides for a caller with no proven identity', () => {
    expect(CALLER).toEqual({ kind: 'anonymous', level: 0 });
    expect(NO_LOOKUPS.scopeOf(CALLER)).toEqual([]);
    expect(NO_LOOKUPS.ownerOf('r-1')).toBeNull();
  });
});

describe('what policyOf refuses', () => {
  const refusal = (b: AgentBusiness): string => {
    try {
      policyOf(b);
    } catch (e) {
      expect(e).toBeInstanceOf(AgentBusinessError);
      return (e as Error).message;
    }
    throw new Error('expected policyOf to refuse');
  };

  it('a rule naming a param the action does not have', () => {
    const message = refusal(business((t) => t.replace('oneOf: { field: consent,', 'oneOf: { field: agreed,')));
    expect(message).toContain('actions.send_text.rules[0]');
    expect(message).toContain('"agreed" is no param of "send_text"');
    expect(message).toContain('phone, consent');
  });

  it('a choice param with no options', () => {
    const b = business();
    const bare = { ...b, actions: { ...b.actions, send_text: { ...b.actions.send_text!, params: { ...b.actions.send_text!.params, consent: { type: 'choice' as const, about: 'Whether.' } } } } };
    expect(refusal(bare)).toMatch(/actions\.send_text\.params\.consent .*no options/);
  });

  it('options on a param that is no choice', () => {
    const message = refusal(business((t) => t.replace('phone: { type: phone, about: The number to text. }', 'phone: { type: phone, options: [a, b], about: The number to text. }')));
    expect(message).toMatch(/actions\.send_text\.params\.phone\.options .*phone/);
  });

  it('a confirmed rule written in the file: the runtime adds it, over every param', () => {
    const message = refusal(business((t) => t.replace('      - oneOf: { field: consent,', '      - confirmed: [phone]\n      - oneOf: { field: consent,')));
    expect(message).toContain('actions.send_text.rules[0]');
    expect(message).toMatch(/confirmed/);
  });

  it('a custom rule, which no code defines in a converse app', () => {
    const message = refusal(business((t) => t.replace('      - oneOf: { field: consent,', '      - custom: vip\n      - oneOf: { field: consent,')));
    expect(message).toContain('actions.send_text.rules[0]');
    expect(message).toContain('custom');
  });
});

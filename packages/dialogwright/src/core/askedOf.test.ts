import { afterAll, describe, expect, it } from 'vitest';
import { isAppDefinitionError } from '../define/defineApp';
import { formatProblem } from '../define/problems';
import { proposalsVariants } from '../testing/proposals/variant';
import { VOICE_RELAY } from '../channel/caps';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import { registerApp } from './app/registry';
import { askedOfCaller, formSlotsFor } from './app/lookup';
import type { App } from './app/types';
import { activeSlots } from './fia';
import { buildQuestions } from './questions';
import { missingSlots, newSession, requiredSlots, setForm, type Session } from './session';
import type { Party } from '../gate/types';
import { testSlotContext } from '../testing/slots';

/**
 * A slot asked only of some callers (slots.yaml `askedOf`, SlotSpec.askedOf; Harbor findings item 5,
 * the maintainer's decision, 2026-10-16): for any other caller it is no part of its forms. On the
 * testkit, the missing-parcel report's note asked only of depot staff (`agent`), or of its clerks.
 */

useTestkit();

const CUSTOMER: Party = { kind: 'customer', level: 2, id: 'C-1', first: 'Avery' };
const CLERK: Party = { kind: 'agent', level: 2, id: 'S-1', first: 'Sam', role: 'clerk' };
const VIEWER: Party = { kind: 'agent', level: 2, id: 'S-2', first: 'Kai', role: 'viewer' };

function appAsking(id: string, askedOf: readonly string[]): App {
  const app: App = { ...testkitApp, id, slots: { ...testkitApp.slots, missingNote: { ...testkitApp.slots.missingNote!, askedOf } } };
  registerApp(app);
  return app;
}

const AGENTS = appAsking('testkit-asked-of-agents', ['agent']);
const CLERKS = appAsking('testkit-asked-of-clerks', ['agent.clerk']);

function reporting(app: App, principal: Session['principal']): Session {
  const s = setForm(newSession('s', 0, VOICE_RELAY, undefined, app.id), 'report_missing');
  s.principal = principal;
  return s;
}

describe('a slot asked only of some callers (askedOf)', () => {
  it('is asked of a kind listed, or of a kind and role listed; never of an anonymous caller; every caller without it', () => {
    expect(askedOfCaller({ askedOf: ['agent'] }, CLERK)).toBe(true);
    expect(askedOfCaller({ askedOf: ['agent'] }, CUSTOMER)).toBe(false);
    expect(askedOfCaller({ askedOf: ['agent.clerk'] }, CLERK)).toBe(true);
    expect(askedOfCaller({ askedOf: ['agent.clerk'] }, VIEWER)).toBe(false);
    expect(askedOfCaller({ askedOf: ['customer'] }, newSession('s', 0, VOICE_RELAY).principal)).toBe(false);
    expect(askedOfCaller({}, CUSTOMER)).toBe(true);
    expect(askedOfCaller(undefined, newSession('s', 0, VOICE_RELAY).principal)).toBe(true);
  });

  it('is no part of the form for anyone else: not required, not missing, not listened for, its question not sent', () => {
    const customer = reporting(AGENTS, CUSTOMER);
    expect(formSlotsFor(AGENTS, 'report_missing', CUSTOMER)).toEqual(['expectedDate']);
    expect(requiredSlots(customer)).toEqual(['expectedDate']);
    expect(missingSlots(customer)).toEqual(['expectedDate']);
    expect(activeSlots(customer).map((s) => s.id)).toEqual(['expectedDate']);
    expect(Object.keys(buildQuestions(customer, testSlotContext('it never came'))).some((q) => q === 'describesParcel')).toBe(false);

    const clerk = reporting(AGENTS, CLERK);
    expect(requiredSlots(clerk)).toEqual(['missingNote', 'expectedDate']);
    expect(activeSlots(clerk).map((s) => s.id)).toEqual(['missingNote', 'expectedDate']);
    expect(Object.keys(buildQuestions(clerk, testSlotContext('it never came'))).some((q) => q === 'describesParcel')).toBe(true);
  });

  it('by role: a clerk is asked it, a viewer is not', () => {
    expect(requiredSlots(reporting(CLERKS, CLERK))).toEqual(['missingNote', 'expectedDate']);
    expect(requiredSlots(reporting(CLERKS, VIEWER))).toEqual(['expectedDate']);
  });

  it('changes nothing for an app whose slots name none', () => {
    expect(requiredSlots(reporting(testkitApp, CUSTOMER))).toEqual(['missingNote', 'expectedDate']);
  });
});

describe('askedOf in slots.yaml, and what check says of it', () => {
  // On the proposals fixture, whose identity.yaml names the subject kind customer and no delegates.
  const variants = proposalsVariants();
  afterAll(() => variants.remove());
  const problemsOf = (slots: (text: string) => string, identity?: (text: string) => string): string[] => {
    try {
      variants.variant({ 'slots.yaml': slots, ...(identity ? { 'identity.yaml': identity } : {}) });
      return [];
    } catch (error) {
      if (isAppDefinitionError(error)) return error.problems.map(formatProblem);
      throw error;
    }
  };
  const onProblem = (askedOf: string) => (t: string): string => t.replace('    instructions: Read asr.text. What does the caller say the problem is?', `    instructions: Read asr.text. What does the caller say the problem is?\n  askedOf: ${askedOf}`);
  const withAgents = (t: string): string => t.replace('  subject: customer', '  subject: customer\n  delegates:\n    agent: { roles: [clerk, viewer] }');

  it('is kept on the slot as built', () => {
    const app = variants.variant({ 'slots.yaml': onProblem('[agent]'), 'identity.yaml': withAgents });
    expect(app.slots.problem!.askedOf).toEqual(['agent']);
  });

  it('names kinds and kind.role pairs identity.yaml has, never on an identity factor', () => {
    expect(problemsOf(onProblem('[agent.clerk, customer]'), withAgents)).toEqual([]);
    expect(problemsOf(onProblem('[agnet]'), withAgents)).toEqual([expect.stringMatching(/^slots\.yaml:\d+:\d+ {2}problem\.askedOf\[0\] {2}the slot "problem" is asked of "agnet", which is not a kind identity\.yaml names \("customer", "agent"\) or one of a delegate kind's roles {2}-> {2}rename it to "agent", or name a kind/)]);
    expect(problemsOf(onProblem('[agent.boss]'), withAgents)).toHaveLength(1);
    const onFactor = (t: string): string => t.replace(/^accountId:\n/m, 'accountId:\n  askedOf: [customer]\n');
    expect(problemsOf(onFactor)).toEqual([expect.stringContaining('the slot "accountId" is an identity factor')]);
    expect(problemsOf(onProblem('[]'))).toEqual([expect.stringContaining('problem.askedOf')]);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { libraryApp } from '../define/fixture/app';
import { compilePolicy } from '../define/policyFile';
import type { PolicyYaml } from '../define/schema/index';
import type { App } from '../core/app/types';
import { defineRule } from '../gate/defineRule';
import { ANONYMOUS } from '../gate/principal';
import { useTestkit } from './apps';
import { cell, configHashOf, expectGeneratedPage, humanize, lowerFirst, mermaidLabel, slotNoun, writeGeneratedPage } from './generatedPage';
import { policyCardText } from './policyCard';
import { testkitApp } from './testkit';

/**
 * What the policy card says, apart from the golden that pins it whole: the words for each rule with
 * its parameters, a role's three outcomes, the fallbacks (no label, no description), the config
 * hashes, what a diagram's labels escape, and how a generated page is checked and written.
 */

useTestkit();

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-pages-'));
  scratch.push(dir);
  return dir;
};

/** The testkit with its policy replaced by this file's actions (the identity, slots and forms are its own). */
function withPolicy(actions: PolicyYaml['actions'], customRules?: Record<string, never>): App {
  const policy = compilePolicy({ actions, purposes: {} } as PolicyYaml, { maxAttempts: 3, ...(customRules ? { customRules } : {}) });
  return { ...testkitApp, policy, gate: undefined } as App;
}

const cardOf = (app: App): string => policyCardText(app, tmp());

describe('the policy card: each rule in words', () => {
  const card = cardOf(withPolicy({
    refundOrder: {
      say: 'refund an order',
      level: 2,
      rules: [
        'identity',
        { role: { viewer: 'refuse', clerk: 'person', reason: 'staff-filing', supervisor: 'allow' } },
        { scope: { record: 'orderId' } },
        { limit: { field: 'amount', min: 0.01, max: 'orderTotal(orderId)' } },
        { dateInRange: { field: 'returnDate', notAfter: 'today', within: 'returnWindow(orderId)', verdicts: { outsideWindow: 'NEEDS_HUMAN' } } },
      ],
    },
    noteOrder: { level: 1, rules: [{ fields: [] }, { scope: { param: 'accountId' } }, { dateInRange: { field: 'startDate', notBefore: '2026-01-31' } }] },
    feeOrder: { level: 1, rules: [{ limit: { field: 'amount', unscoped: true, max: 'feeSchedule(orderId)' } }] },
    scheduleOrder: { level: 1, rules: [{ dateInRange: { field: 'startDate', notBefore: 'today-1', notAfter: 'today+30' } }, { dateInRange: { field: 'endDate', notBefore: 'today+1', notAfter: 'today+3660' } }, { dateInRange: { field: 'callbackDate', notAfter: 'today-7' } }] },
    openThing: { level: 0, rules: [] },
  }));

  it('says the level by its name, and a level 0 action as open to any caller', () => {
    expect(card).toContain("1. the caller must be at 'confirmed by code' or above");
    expect(card).toContain('| `openThing` | 0 anonymous | nothing: no rule runs |');
  });

  it('says what a role rule gives each role, the reason a person takes it, and who it leaves out', () => {
    expect(card).toContain("by role: a viewer's request is refused; a clerk's request goes to a person (staff-filing); a supervisor's request goes ahead; any other role, or none, is refused; a customer acting for themselves is not held to this rule");
  });

  it('lists the actions no role rule governs, for every role and a party with no role, and the identity checks as refused', () => {
    expect(card).toContain('| every role, and a party with no role | noteOrder<br/>feeOrder<br/>scheduleOrder<br/>openThing | none | none |');
    expect(card).toContain('The last row is every action that has no role rule: every role, and a party with no role, goes ahead to its other rules');
    const own = policyCardText(testkitApp, tmp());
    expect(own).toContain("| every role, and a party with no role | read the customer's account<br/>read the delivery windows<br/>list the customer's parcels<br/>read a parcel<br/>tell the depot about a report | none | check the account ID and date of birth<br/>text a one-time code<br/>check the one-time code |");
  });

  it('says where a hidden value keeps its year and where it is a dot', () => {
    const own = policyCardText(testkitApp, tmp());
    expect(own).toContain('date of birth hidden (the trace keeps only its year, `••/••/1985`; a call as recorded, in the gate\'s decision, the console and the audit, shows `•`)');
    expect(own).toContain('| date of birth (`dob`) | hidden (`•`) |');
  });

  it('says a record the action names belongs to the caller or someone they act for, and a param is the caller\'s own or one they act for', () => {
    expect(card).toContain('the order ID must belong to the caller, or to someone they act for');
    expect(card).toContain("the account ID must be the caller's own, or one they act for");
  });

  it('says the bounds of a limit and of a date, what a lookup gives, and the verdict outside them', () => {
    expect(card).toContain("the amount must be at least 0.01 and at most what `orderTotal(orderId)` gives (a number outside it is refused; anything that is not a number is refused); `orderTotal` reads the order ID the scope rule above holds to the caller's own records, or those they act for");
    expect(card).toContain("the return date must be on or before today and inside the window `returnWindow(orderId)` gives (a date out of bounds is refused; one outside the window goes to a person; anything that is not a date is refused); `returnWindow` reads the order ID the scope rule above holds to the caller's own records, or those they act for");
    expect(card).toContain('the start date must be on or after 2026-01-31 (a date out of bounds is refused; anything that is not a date is refused)');
    expect(card).toContain('the start date must be no earlier than 1 day before today and no later than 30 days from today (a date out of bounds is refused; anything that is not a date is refused)');
    expect(card).toContain('the end date must be no earlier than 1 day from today and no later than 3660 days from today (a date out of bounds is refused; anything that is not a date is refused)');
    expect(card).toContain('the callback date must be no later than 7 days before today (a date out of bounds is refused; anything that is not a date is refused)');
    // A rule whose lookup is about no caller's own record says so.
    expect(card).toContain("the amount must be at most what `feeSchedule(orderId)` gives (a number outside it is refused; anything that is not a number is refused); `feeSchedule` is about no caller's own record, so every caller is held to the same bounds");
  });

  it('says a fields rule with no field sends none, and labels an action by its tool id when it has no say', () => {
    expect(card).toContain('only these fields are sent: none');
    expect(card).toContain('| `noteOrder` | 1 verified |');
    expect(card).toContain('| **Refund an order**<br/>`refundOrder` | 2 confirmed by code |');
  });

  it('draws each action in its level, with what each role outside "goes ahead" gets', () => {
    expect(card).toContain('a_noteOrder["noteOrder<br/>fields · scope · dateInRange startDate"]');
    expect(card).toContain('a_refundOrder -.->|"viewer"| refused');
    expect(card).toContain('a_refundOrder -.->|"clerk"| person');
    expect(card).not.toContain('"supervisor"');
  });
});

describe('the policy card: custom rules and the files', () => {
  const rule = defineRule({
    id: 'only-mornings',
    description: 'The visit is booked in the morning',
    run: (c) => (c.call.params.part === 'morning' ? { pass: true, compared: 'morning' } : { pass: false, compared: 'not morning', verdict: 'BLOCK', reason: 'part' }),
    examples: [
      { name: 'morning', call: { params: { part: 'morning' } }, principal: ANONYMOUS, expect: { verdict: 'ALLOW' } },
      { name: 'evening', call: { params: { part: 'evening' } }, principal: ANONYMOUS, expect: { verdict: 'BLOCK', reason: 'part' } },
    ],
  });

  it('says a custom rule by its static description and its id, and a plain function as the app\'s own rule', () => {
    const plain = (() => ({ result: { id: 'x', description: '', compared: '', pass: true } })) as never;
    const card = cardOf(withPolicy({ a: { level: 0, rules: [{ custom: 'only-mornings' }] }, b: { level: 0, rules: [{ custom: 'plain' }] } }, { 'only-mornings': rule, plain } as never));
    expect(card).toContain('1. the visit is booked in the morning (custom rule `only-mornings`)');
    expect(card).toContain("1. the app's own rule (no description given) (custom rule `plain`)");
  });

  it('reads the config hashes of policy.yaml and identity.yaml beside the card, and says so when a file is not there', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'policy.yaml'), 'actions: {}\n');
    const app = { ...testkitApp, configHashes: undefined } as App;
    const card = policyCardText(app, dir);
    expect(card).toContain(`| \`policy.yaml\` | \`${configHashOf(app, dir, 'policy.yaml')}\` |`);
    expect(configHashOf(app, dir, 'policy.yaml')).toMatch(/^[0-9a-f]{64}$/);
    expect(card).toContain('| `identity.yaml` | none: this app verifies no one |');
    // a comment or another layout of the same content is the same hash
    writeFileSync(join(dir, 'policy.yaml'), '# a comment\nactions:  {  }\n');
    expect(configHashOf(app, dir, 'policy.yaml')).toBe(configHashOf(app, dir, 'policy.yaml'));
    expect(policyCardText(app, dir)).toBe(card);
  });

  it('takes an app folder\'s hashes from the app, as the call\'s audit row records them', () => {
    expect(libraryApp.configHashes).toBeDefined();
    expect(configHashOf(libraryApp, '/nowhere', 'policy.yaml')).toBe(libraryApp.configHashes!.files['policy.yaml']);
  });
});

describe('the words the pages share', () => {
  it('spells an id out, and lowers a label unless it starts with an acronym', () => {
    expect(humanize('missingNote')).toBe('missing note');
    expect(humanize('accountId')).toBe('account ID');
    expect(humanize('report_missing')).toBe('report missing');
    expect(lowerFirst('Date of birth')).toBe('date of birth');
    expect(lowerFirst('Account ID')).toBe('account ID');
    expect(lowerFirst('ID card')).toBe('ID card');
    expect(slotNoun(testkitApp, 'accountId')).toBe('account ID');
    expect(slotNoun(testkitApp, 'dob')).toBe('date of birth');
    expect(slotNoun(testkitApp, 'noSuchSlot')).toBe('no such slot');
  });

  it('escapes what would end a Mermaid label or a table cell', () => {
    expect(mermaidLabel('say "hi" <b>', 'next')).toBe('"say #quot;hi#quot; #lt;b#gt;<br/>next"');
    expect(cell('a | b\nc')).toBe('a \\| b c');
  });
});

describe('the generated page goldens', () => {
  it('writes a page only when it changed, and fails with a diff and the command that writes it', () => {
    const file = join(tmp(), 'POLICY.md');
    expect(() => expectGeneratedPage(libraryApp, file, 'one\n', 'pnpm policy:card x', 'policy card')).toThrow('there is no policy card at');
    expect(writeGeneratedPage(file, 'one\ntwo\n')).toEqual({ changed: true, lines: 2 });
    expect(writeGeneratedPage(file, 'one\ntwo\n')).toEqual({ changed: false, lines: 2 });
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
    let message = '';
    try {
      expectGeneratedPage(libraryApp, file, 'one\nthree\n', 'pnpm policy:card x', 'policy card');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('is not the policy card "library" generates today');
    expect(message).toContain('- two');
    expect(message).toContain('+ three');
    expect(message).toContain('write it with `pnpm policy:card x`');
  });
});

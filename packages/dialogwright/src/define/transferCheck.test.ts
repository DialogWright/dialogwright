import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { CALLBACK_DIR, callbackApp, callbackCode } from '../testing/callback/app';
import { validateApp } from '../core/app/validate';
import { appSchema } from './schema/app';

/**
 * What `check` says of app.yaml's `transfer` (design 2026-10-09-call-data-and-transfers, 2b decision 8):
 * it refuses an unknown form, call data key or slot, a secret key sent, a target that is not
 * `env.<NAME>`, a header name that is not an `X-` name or `User-to-User`, and a missing default; it
 * warns of a reason no handoff has a line for, a rule after one that always holds, a constant that
 * looks like a misspelled reference, and a header the carrier reserves. Business choices (which
 * targets, in what order, what goes with them) are the app's.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function folder(change: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-transfer-'));
  scratch.push(dir);
  cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  writeFileSync(join(dir, 'app.yaml'), change(readFileSync(join(dir, 'app.yaml'), 'utf8')));
  return dir;
}

async function resultOf(change: (text: string) => string): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(folder(change), { code: callbackCode, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('builds App.transfer: each when a list of conditions, each send as written', () => {
    expect(callbackApp.transfer).toEqual({
      targets: [
        { when: [{ kind: 'callData', key: 'queue', test: { is: 'priority' } }], to: 'env.PRIORITY_LINE', send: { headers: { 'X-Queue': 'callData.queue' } } },
        { when: [{ kind: 'form', forms: ['request_callback'] }, { kind: 'reason', reasons: ['max-attempts'] }], to: 'env.CALLBACK_DESK' },
        { when: [{ kind: 'reason', reasons: ['security'] }], to: 'env.SECURITY_DESK', send: { headers: { 'X-Priority': '1' } } },
      ],
      default: 'env.MAIN_LINE',
      send: {
        headers: { 'X-Account-Ref': 'callData.accountRef', 'X-Reason': 'reason', 'X-Form': 'form', 'X-About': 'slot.reason', 'X-Source': 'ivr' },
        chat: { reason: 'reason', page: 'callData.page' },
      },
    });
  });
});

describe('app.yaml transfer: refusals', () => {
  it('refuses a form, a call data key or a slot the app does not have', async () => {
    const form = await resultOf(replace('{ form: request_callback }', '{ form: request_refund }'));
    expect(form.problems).toHaveLength(1);
    expect(form.problems[0]).toContain('transfer.targets[1].when[0].form');
    expect(form.problems[0]).toContain('form "request_refund" is not defined');
    const key = await resultOf(replace('when: { callData: queue, is: priority }', 'when: { callData: lane, is: priority }'));
    expect(key.problems).toHaveLength(1);
    // A rule's when written as one condition has no index of its own in the file.
    expect(key.problems[0]).toContain('transfer.targets[0].when.callData');
    expect(key.problems[0]).toContain('callData key "lane" is not defined');
    const sent = await resultOf(replace('X-Account-Ref: callData.accountRef', 'X-Account-Ref: callData.account'));
    expect(sent.problems[0]).toContain('transfer.send.headers.X-Account-Ref');
    const slot = await resultOf(replace('X-About: slot.reason', 'X-About: slot.topic'));
    expect(slot.problems).toHaveLength(1);
    expect(slot.problems[0]).toContain('slot "topic" is not defined');
  });

  it('refuses a call data key sent masked and recorded secret: nothing would be sent; a secret key sent as-is is the app\'s to send', async () => {
    // Re-pinned (live findings item 26): recording and delivery are separate, so a key recorded secret is sent as it came by default.
    const asIs = await resultOf(replace('accountRef: { from: param.accountRef, redact: last4 }', 'accountRef: { from: param.accountRef, redact: secret }'));
    expect(asIs.problems).toEqual([]);
    const r = await resultOf(replace('accountRef: { from: param.accountRef, redact: last4 }', 'accountRef: { from: param.accountRef, redact: secret, send: masked }'));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('callData key "accountRef" is sent masked and recorded secret, so it is never sent');
  });

  it('refuses a target that is not env.<NAME>, a header that is not an X- name or User-to-User, and a missing default', async () => {
    const to = await resultOf(replace('to: env.SECURITY_DESK', 'to: "+15555550100"'));
    expect(to.problems).toHaveLength(1);
    expect(to.problems[0]).toContain('transfer.targets[2].to');
    expect(to.problems[0]).toContain('is not an environment variable');
    const header = await resultOf(replace('X-Source: ivr', 'Source: ivr'));
    expect(header.problems).toHaveLength(1);
    expect(header.problems[0]).toContain('is not a header a transfer may send');
    expect((await resultOf(replace('X-Source: ivr', 'User-to-User: callData.accountRef'))).problems).toEqual([]);
    const missing = await resultOf(replace('  default: env.MAIN_LINE\n', ''));
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain('transfer.default');
  });

  it('refuses two header names that differ only in case, within one send: one header sent twice', async () => {
    const r = await resultOf(replace('X-Source: ivr', 'X-Source: ivr\n      x-source: web'));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('transfer.send.headers.x-source');
    expect(r.problems[0]).toContain('"x-source" is the header "X-Source" again: header names are not case-sensitive');
    // Across a rule's send and the top-level one, the rule's replaces it (core/transfer.ts sendOf): no refusal.
    expect((await resultOf(replace('headers: { X-Priority: "1" }', 'headers: { X-Priority: "1", x-reason: security }'))).problems).toEqual([]);
  });

  it('refuses a condition with two subjects, or a test on one that takes none', async () => {
    const two = await resultOf(replace('when: { reason: security }', 'when: { reason: security, form: request_callback }'));
    expect(two.problems).toHaveLength(1);
    expect(two.problems[0]).toContain('a condition has one subject');
    const test = await resultOf(replace('when: { reason: security }', 'when: { reason: security, is: x }'));
    expect(test.problems[0]).toContain('reason takes no is');
  });
});

describe('app.yaml transfer: warnings, never refusals', () => {
  it('warns of a reason no handoff has a line for: the condition never holds', async () => {
    const r = await resultOf(replace('when: { reason: security }', 'when: { reason: billing }'));
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('no handoff has the reason "billing" (prompts.yaml has no handoff_billing)');
  });

  it('warns of a rule after one that always holds', async () => {
    const r = await resultOf(replace('    - when: { reason: security }\n', '    - to: env.SECURITY_DESK\n    - when: { reason: security }\n'));
    expect(r.problems).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('transfer.targets[3]');
    expect(r.warnings[0]).toContain('is never taken: rule 3 before it always holds');
  });

  it('warns of a header or a chat value naming a call data key sent masked and recorded by mask or length: it can only ever send the mask', async () => {
    // Re-pinned (live findings item 26): a key is sent as it came by default; only one whose send says masked sends as it is recorded.
    const plain = await resultOf(replace('X-Source: ivr', 'X-Referral: callData.referral'));
    expect(plain.problems).toEqual([]);
    expect(plain.warnings).toEqual([]);
    const masked = await resultOf((t) => replace('X-Source: ivr', 'X-Referral: callData.referral')(replace('referral: { from: webhook.SipHeader_X-Referral }', 'referral: { from: webhook.SipHeader_X-Referral, send: masked }')(t)));
    expect(masked.problems).toEqual([]);
    expect(masked.warnings).toHaveLength(1);
    expect(masked.warnings[0]).toContain('callData key "referral" is sent masked and recorded by mask (the default), so this can only ever send •');
    const length = await resultOf((t) => replace('chat: { reason: reason, page: callData.page }', 'chat: { reason: reason, ref: callData.accountRef }')(replace('accountRef: { from: param.accountRef, redact: last4 }', 'accountRef: { from: param.accountRef, redact: length, send: masked }')(t)));
    expect(length.problems).toEqual([]);
    expect(length.warnings.join('\n')).toContain('callData key "accountRef" is sent masked and recorded by length, so this can only ever send its length');
  });

  it('warns of a constant that looks like a misspelled reference, and of a header Telnyx reserves', async () => {
    const r = await resultOf(replace('X-Source: ivr', 'X-Source: Reason'));
    expect(r.problems).toEqual([]);
    expect(r.warnings[0]).toContain('is sent as written, as a constant, though it looks like a reference');
    const reserved = await resultOf(replace('X-Source: ivr', 'X-Telnyx-Source: ivr'));
    expect(reserved.problems).toEqual([]);
    expect(reserved.warnings[0]).toContain('a header Telnyx reserves');
  });

  it('takes a condition on a chat key: routing a visitor by their own page is the app\'s choice', async () => {
    const r = await resultOf(replace('when: { callData: queue, is: priority }', 'when: { callData: page, present: true }'));
    expect(r).toEqual({ problems: [], warnings: [] });
  });
});

describe('the schema and validateApp', () => {
  it('the schema takes the plan\'s transfer', () => {
    const r = appSchema.safeParse({
      id: 'x',
      transfer: {
        targets: [
          { when: { callData: 'queue', is: 'vip' }, to: 'env.VIP_NUMBER' },
          { when: { form: ['billing_question', 'payment'] }, to: 'env.BILLING_NUMBER' },
          { when: { reason: ['emergency'] }, to: 'env.EMERGENCY_NUMBER', send: { headers: { 'X-Priority': '1' } } },
        ],
        default: 'env.HANDOFF_NUMBER',
        send: { headers: { 'X-Account-Ref': 'callData.accountRef', 'X-Reason': 'reason', 'X-Form': 'form', 'X-Member': 'slot.memberId' }, chat: { reason: 'reason', form: 'form' } },
      },
    });
    expect(r.success).toBe(true);
  });

  it('validateApp refuses what check refuses, for an app built in code', () => {
    const app = { ...callbackApp, transfer: { ...callbackApp.transfer!, default: '+15555550100' } };
    expect(() => validateApp(app)).toThrow('transfer: "+15555550100" is not an environment variable (transfer.default)');
    const form = { ...callbackApp, transfer: { targets: [{ when: [{ kind: 'form' as const, forms: ['nope'] }], to: 'env.X' }], default: 'env.HANDOFF_NUMBER' } };
    expect(() => validateApp(form)).toThrow('transfer: form "nope" is not defined (transfer.targets.0.when.0.form)');
    const header = { ...callbackApp, transfer: { targets: [], default: 'env.HANDOFF_NUMBER', send: { headers: { Accept: 'reason' } } } };
    expect(() => validateApp(header)).toThrow('"Accept" is not a header a transfer may send');
    // A malformed test in the engine's shape is refused here, not at the first handoff it would crash.
    const test = { ...callbackApp, transfer: { targets: [{ when: [{ kind: 'callData', key: 'queue', test: {} } as never], to: 'env.X' }], default: 'env.MAIN_LINE' } };
    expect(() => validateApp(test)).toThrow('transfer: is a callData condition whose test has none of is, in, notIn and present, and takes exactly one (transfer.targets.0.when.0)');
    const notList = { ...callbackApp, transfer: { targets: [{ when: { kind: 'reason', reasons: ['x'] } as never, to: 'env.X' }], default: 'env.MAIN_LINE' } };
    expect(() => validateApp(notList)).toThrow('transfer: is not a list of conditions (transfer.targets.0.when)');
    expect(() => validateApp(callbackApp)).not.toThrow();
  });
});

describe('the conditions routes add, on a transfer target (design 2026-10-09-routes, decision 4)', () => {
  const target = (when: string) => replace("    - when: { reason: security }\n", `    - when: ${when}\n      to: env.SECURITY_DESK\n    - when: { reason: security }\n`);
  it('takes a fact, a slot and a level', async () => {
    expect((await resultOf(target('[{ fact: tier, is: gold }, { slot: phone, present: true }, { level: 1 }]'))).problems).toEqual([]);
  });
  it('refuses hours the app does not have and a predicate the code does not write; the number called is kept for every app', async () => {
    const { problems } = await resultOf(target('[{ hours: closed }, { named: vip }, { called: env.SALES_LINE }]'));
    expect(problems.join('\n')).toContain('transfer.targets[2].when[0].hours  app.yaml has no hours, so this condition never holds');
    expect(problems.join('\n')).toContain('transfer.targets[2].when[1].named  the code has no predicate "vip"');
    // Re-pinned (live findings item 26): a called condition needs no opt-in.
    expect(problems.join('\n')).not.toContain('transfer.targets[2].when[2].called');
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { gateOf } from '../core/app/lookup';
import type { App, Completion, CompletionContext, ToolDef } from '../core/app/types';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { newSession } from '../core/session';
import { VOICE_RELAY } from '../channel/caps';
import { confirmationHash } from '../gate/lines';
import { ANONYMOUS } from '../gate/principal';
import type { ToolCall } from '../gate/types';
import { policyCardText } from '../testing/policyCard';
import { businessContentProblems } from './business';
import { defineApp } from './defineApp';
import { businessSchema, type BusinessYaml } from './schema/business';
import { BUSINESS_FIXTURE_DIR, businessFixtureCode, type LibrarySystems } from './__fixtures__/business/app';

/**
 * A tool a form's yes calls only on a field's option (business.yaml's `{ tool, when }`): the fixture
 * library with a consent field (`textOk`) on its hold and the desk's notice held to its yes. The
 * condition is the gate's: a oneOf rule on the param, so a no is refused and audited, and the form goes
 * on without the tool. And a choice option said one way in the read-back and another in the done line.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The fixture's business.yaml, as read. */
const BASE = parse(readFileSync(join(BUSINESS_FIXTURE_DIR, 'business.yaml'), 'utf8')) as Record<string, unknown>;

/** The fixture library with `edit` applied to its business.yaml, in a folder of its own. */
function folderWith(edit: (b: Record<string, any>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'business-when-'));
  dirs.push(dir);
  cpSync(BUSINESS_FIXTURE_DIR, dir, { recursive: true });
  const b = structuredClone(BASE) as Record<string, any>;
  edit(b);
  writeFileSync(join(dir, 'business.yaml'), stringify(b));
  return dir;
}

/** The hold with a consent field, the desk's notice held to its yes, and the read-back and done line saying it. */
function withConsent(b: Record<string, any>): void {
  b.request.fields.push({
    name: 'textOk', type: 'choice', options: ['yes', 'no'], question: 'Is it OK if we text you at that number?',
    says: { yes: { readBack: "and we'll text you at", done: "We'll text you when it's ready." }, no: { readBack: "and we'll call you at", done: "We'll call you when it's ready." } },
  });
  b.request.readBack = "Here's the hold: {patronName}, {copies} of {title} {format}, collected {day} in the {window}, {textOk} {callbackNumber}. Is that right?";
  b.request.done = 'Thanks, {patronName}. {textOk}';
  b.request.then = ['placeHold', { tool: 'notifyDesk', when: { field: 'textOk', is: 'yes', reason: 'no-consent' } }];
}

const REQUEST = ['patronName', 'title', 'copies', 'format', 'day', 'window', 'callbackNumber', 'textOk'];
const tools: Record<string, ToolDef> = {
  ...businessFixtureCode.tools,
  placeHold: { ...businessFixtureCode.tools.placeHold!, params: REQUEST },
  notifyDesk: { ...businessFixtureCode.tools.notifyDesk!, params: REQUEST },
};

resetAppsForTest();
const DIR = folderWith(withConsent);
const app: App = defineApp(DIR, { ...businessFixtureCode, tools }, { codeFile: 'app.ts' });
registerApp(app);

const HOLD = { patronName: 'avery lane', title: 'The Quiet Harbor', copies: 'two', format: 'print', day: '2026-11-12', window: 'morning', callbackNumber: '5555550144' };

/** A hold's completion run through the real gate, its tools run where it allows them: the calls' verdicts and what it said. */
function complete(textOk: 'yes' | 'no'): { verdicts: Record<string, { verdict: string; reason?: string }>; done: Completion; sys: LibrarySystems } {
  const s = newSession('S-when', 0, VOICE_RELAY, ANONYMOUS, app.id);
  const values: Record<string, string> = { ...HOLD, textOk };
  for (const [field, value] of Object.entries(values)) Object.assign(s.slots[`request_${field}`]!, { value, display: value });
  s.form = 'request';
  s.pendingHash = confirmationHash(values, REQUEST);
  const sys = app.systems().sys as LibrarySystems;
  const verdicts: Record<string, { verdict: string; reason?: string }> = {};
  const c = {
    s,
    acks: [],
    callTool: (call: ToolCall) => {
      const decision = gateOf(app).evaluate(call, s.principal, { attempts: 0, confirmedHash: s.confirmedHash, todayIso: '2026-11-09' }, app.systems().lookups);
      verdicts[call.tool] = { verdict: decision.verdict, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
      if (decision.verdict !== 'ALLOW') return { decision, value: null };
      app.tools[call.tool]!.run(call, sys, { s, tc: {} as never, out: {} as never, env: () => undefined });
      return { decision, value: { ok: true } };
    },
    refusal: () => ({ kind: 'refused', acks: [] }) as unknown as Completion,
  } as unknown as CompletionContext;
  return { verdicts, done: app.forms.request!.complete!(c), sys };
}

describe('a tool held to a field\'s option (`when`)', () => {
  it('is a oneOf rule on the param, after the read-back\'s confirmation', () => {
    expect(app.policy.rulesFor.notifyDesk).toEqual(expect.arrayContaining(['oneOf']));
    expect(app.agent!.forms.request!.when).toEqual({ notifyDesk: { field: 'textOk', is: 'yes', reason: 'no-consent' } });
  });

  it('with the caller\'s yes, runs, and the done line says the yes\'s words', () => {
    const { verdicts, done, sys } = complete('yes');
    expect(verdicts).toEqual({ placeHold: { verdict: 'ALLOW' }, notifyDesk: { verdict: 'ALLOW' } });
    expect(sys.told).toHaveLength(1);
    expect(done).toMatchObject({ kind: 'said', acks: [{ promptId: 'done_request', vars: { request_textOk: "We'll text you when it's ready." } }] });
  });

  it('with a no, the gate refuses it (no-consent), and the form goes on without it: the write made, the done line said', () => {
    const { verdicts, done, sys } = complete('no');
    expect(verdicts).toEqual({ placeHold: { verdict: 'ALLOW' }, notifyDesk: { verdict: 'BLOCK', reason: 'no-consent' } });
    expect(sys.holds).toHaveLength(1);
    expect(sys.told).toEqual([]);
    expect(done).toMatchObject({ kind: 'said', acks: [{ promptId: 'done_request', vars: { request_textOk: "We'll call you when it's ready." } }] });
  });

  it('the read-back says the option\'s read-back words', () => {
    const s = newSession('S-rb', 0, VOICE_RELAY, ANONYMOUS, app.id);
    Object.assign(s.slots.request_textOk!, { value: 'yes', display: 'yes' });
    expect(app.forms.request!.onSummaryRead!({ s, acks: [] } as never)).toEqual({ vars: { request_format: 'in either print', request_textOk: "and we'll text you at" } });
  });

  it('the policy card names the action, the field and option it is held to, and the reason it is refused as', () => {
    const card = policyCardText(app, DIR);
    expect(card).toContain("### Done only on the caller's answer");
    expect(card).toMatch(/\| .*\(`notifyDesk`\), after the request's read-back \| .*\(`textOk`\) is `yes` \| `no-consent` \|/);
  });
});

describe('pnpm check holds a condition to a choice field of the form and one of its options', () => {
  const problems = (edit: (b: Record<string, any>) => void): string[] => {
    const b = structuredClone(BASE) as Record<string, any>;
    withConsent(b);
    edit(b);
    const out: string[] = [];
    businessContentProblems(businessSchema.parse(b) as BusinessYaml, (path, message) => out.push(`${path.join('.')}: ${message}`));
    return out;
  };

  it('none for the consent above', () => {
    expect(problems(() => undefined)).toEqual([]);
  });

  it('a field the form does not have', () => {
    expect(problems((b) => { b.request.then[1].when.field = 'textOkay'; })).toEqual(['request.then.1.when.field: "textOkay" is not a field of the request']);
  });

  it('a field that is not a choice', () => {
    expect(problems((b) => { b.request.then[1].when.field = 'title'; })).toEqual(["request.then.1.when.field: the field \"title\" is text, but a condition reads a choice field's option"]);
  });

  it('an option the field does not have', () => {
    expect(problems((b) => { b.request.then[1].when.is = 'maybe'; })).toEqual(['request.then.1.when.is: "maybe" is not an option of "textOk"']);
  });

  it('an optional field, which the form may send never asked (call 46)', () => {
    expect(problems((b) => { b.request.fields.find((f: { name: string }) => f.name === 'textOk').optional = true; b.request.fields.find((f: { name: string }) => f.name === 'textOk').says.unset = 'or call you at'; })).toContain('request.then.1.when.field: the field "textOk" is optional, so the form may be sent with it never asked, and "notifyDesk" refused for an answer the caller never gave');
  });

  it('a reason the gate gives of its own is refused by the schema (call 46)', () => {
    const b = structuredClone(BASE) as Record<string, any>;
    withConsent(b);
    b.request.then[1].when.reason = 'confirmation';
    const parsed = businessSchema.safeParse(b);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('is a reason the gate gives of its own');
  });

  it('the form\'s write, which a yes always makes', () => {
    expect(problems((b) => { b.request.then = [{ tool: 'placeHold', when: { field: 'textOk', is: 'yes' } }, 'notifyDesk']; })).toEqual(["request.then.0.when: \"placeHold\" is the request's write (its first tool), which a yes always makes, so it cannot be held to a condition"]);
  });
});

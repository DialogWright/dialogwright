import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { businessContentProblems } from './business';
import { businessSchema, type BusinessYaml } from './schema/business';
import { BUSINESS_FIXTURE_DIR } from './__fixtures__/business/app';

/**
 * A tool a form's yes calls only on a field's option (business.yaml's `{ tool, when }`): the fixture
 * library with a consent field (`textOk`) on its hold and the desk's notice held to its yes. The
 * condition is the gate's: a oneOf rule on the param, so a no is refused and audited, and the form goes
 * on without the tool. And a choice option said one way in the read-back and another in the done line.
 */

/** The fixture's business.yaml, as read. */
const BASE = parse(readFileSync(join(BUSINESS_FIXTURE_DIR, 'business.yaml'), 'utf8')) as Record<string, unknown>;

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

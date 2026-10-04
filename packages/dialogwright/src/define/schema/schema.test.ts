import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ZodType } from 'zod';
import { SCHEMAS, FILE_KINDS, FILE_NAMES, type FileKind } from './index';
import { SCHEMAS_DIR } from './generate';
import { jsonSchemas, kbJsonSchemas, localeSlotsJsonSchema, serializeSchema, slotsJsonSchema } from './json';
import { slotsSchema } from './slots';

const FIXTURE = join(__dirname, '..', '__fixtures__', 'valid');
/** The folders of the other apps this package runs from policy.yaml and identity.yaml: the library fixture and the testkit. */
const APPS = { library: join(__dirname, '..', 'fixture'), testkit: join(__dirname, '..', '..', 'testing', 'testkit') };

/** What a schema says is wrong with `source` (YAML text), as `path: message` lines, with the issue codes beside. */
function issuesOf(kind: FileKind, source: string): { path: string; code: string; message: string }[] {
  const result = (SCHEMAS[kind] as ZodType).safeParse(parse(source));
  if (result.success) return [];
  return result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message }));
}

describe('a valid example of each kind parses', () => {
  for (const kind of FILE_KINDS) {
    it(`${FILE_NAMES[kind]}`, () => {
      const result = (SCHEMAS[kind] as ZodType).safeParse(parse(readFileSync(join(FIXTURE, FILE_NAMES[kind]), 'utf8')));
      expect(result.error?.issues ?? []).toEqual([]);
    });
  }

  for (const [app, dir] of Object.entries(APPS)) {
    for (const kind of ['policy', 'identity'] as const) {
      it(`${app}'s ${FILE_NAMES[kind]}`, () => {
        let text: string;
        try {
          text = readFileSync(join(dir, FILE_NAMES[kind]), 'utf8');
        } catch {
          return; // an app that verifies no one has no identity.yaml
        }
        expect(SCHEMAS[kind].safeParse(parse(text)).error?.issues ?? []).toEqual([]);
      });
    }
  }

  it('keeps the order intents, forms and prompts are written in (the decision model is offered intents in order)', () => {
    const intents = SCHEMAS.intents.parse(parse(readFileSync(join(FIXTURE, 'intents.yaml'), 'utf8')));
    expect(Object.keys(intents.intents)).toEqual(['schedule_new', 'cancel', 'billing', 'agent', 'repeat_prompt', 'capabilities']);
    expect(intents.menu.map((m) => m.digit)).toEqual(['1', '2', '3', '0']);
  });

  it('fills in what is left out: a prompt is fixed, and a policy has no purposes', () => {
    const prompts = SCHEMAS.prompts.parse({ prompts: { hello: { text: 'Hi', interruptible: true } } });
    expect(prompts.prompts.hello!.mode).toBe('fixed');
    expect(SCHEMAS.policy.parse({ actions: { a: { rules: [] } } })).toEqual({ actions: { a: { rules: [] } }, purposes: {} });
  });

  it('reads the keys true and false (YAML booleans) as the words the model criteria are filed under', () => {
    const app = SCHEMAS.app.parse(parse('id: x\nwording:\n  tentative:\n    true: a hedge\n    false: plain\n'));
    expect(app.wording?.tentative).toEqual({ true: 'a hedge', false: 'plain' });
  });
});

describe('mistakes get a precise error', () => {
  it('a typo in a key names the key and where it is', () => {
    expect(issuesOf('forms', 'forms:\n  cancel:\n    slots: [name]\n    summaryPrompId: x\n    hooks: [complete]\n')).toEqual([
      { path: 'forms.cancel.summaryPromptId', code: 'invalid_type', message: 'Invalid input: expected string, received undefined' },
      { path: 'forms.cancel', code: 'unrecognized_keys', message: 'Unrecognized key: "summaryPrompId"' },
    ]);
  });

  it('a value of the wrong type names the expected and received types', () => {
    expect(issuesOf('identity', 'principals: { subject: patient }\nlevels: { 1: { name: verified, factors: [patientId], verify: verifyPatient } }\nattempts: three\n')).toEqual([
      { path: 'attempts', code: 'invalid_type', message: 'must be a number' },
    ]);
    expect(issuesOf('prompts', 'prompts:\n  hello:\n    text: Hi\n    interruptible: "yes"\n')).toEqual([
      { path: 'prompts.hello.interruptible', code: 'invalid_type', message: 'must be true or false' },
    ]);
  });

  it('a missing required field names the field', () => {
    expect(issuesOf('identity', 'principals: { subject: patient }\nlevels:\n  1: { name: a, factors: [x], verify: v }\n  2: { name: b, factors: [{ otp: {} }], verify: c }\nattempts: 3\n')).toEqual([
      { path: 'levels.2.send', code: 'invalid_type', message: 'Invalid input: expected string, received undefined' },
    ]);
    expect(issuesOf('identity', 'principals: { subject: patient }\nattempts: 3\n')).toEqual([
      { path: 'levels', code: 'invalid_type', message: 'Invalid input: expected object, received undefined' },
    ]);
    expect(issuesOf('policy', 'actions: { a: { level: 1 } }\n')).toEqual([
      { path: 'actions.a.rules', code: 'invalid_type', message: 'Invalid input: expected array, received undefined' },
    ]);
    expect(issuesOf('app', 'locale: en-US\n')).toEqual([{ path: 'id', code: 'invalid_type', message: 'Invalid input: expected string, received undefined' }]);
  });

  it('an unknown key is an error at every level (the schemas are strict)', () => {
    expect(issuesOf('app', 'id: x\nflavour: mint\n')).toEqual([{ path: '', code: 'unrecognized_keys', message: 'Unrecognized key: "flavour"' }]);
    expect(issuesOf('app', 'id: x\nbrand: { name: A, mark: B, colour: red }\n')).toEqual([
      { path: 'brand', code: 'unrecognized_keys', message: 'Unrecognized key: "colour"' },
    ]);
  });

  it('a value outside an enum lists what is allowed', () => {
    const [issue] = issuesOf('intents', 'intents:\n  a: { criteria: c, label: l, kind: forms }\nmenu: []\n');
    expect(issue).toMatchObject({ path: 'intents.a.kind', code: 'invalid_value' });
    expect(issue!.message).toBe('Invalid option: expected one of "form"|"informational"|"control"');
  });

  it('an id that is not a plain word is refused, as a key and as a value', () => {
    const word = 'is not a valid id: it must start with a letter and use only letters, digits and underscores';
    expect(issuesOf('forms', 'forms:\n  "cancel it":\n    slots: [name]\n    summaryPromptId: null\n    hooks: [complete]\n')).toMatchObject([
      { path: 'forms.cancel it', code: 'invalid_key' },
    ]);
    expect(issuesOf('forms', 'forms:\n  cancel:\n    slots: ["first name"]\n    summaryPromptId: null\n    hooks: [complete]\n')).toEqual([
      { path: 'forms.cancel.slots.0', code: 'invalid_format', message: word },
    ]);
  });

  it('a form without a complete hook, a repeated slot, and a repeated hook are each named', () => {
    expect(issuesOf('forms', 'forms:\n  a:\n    slots: [x, x]\n    summaryPromptId: null\n    hooks: [onSummaryRead, onSummaryRead]\n')).toEqual([
      { path: 'forms.a.slots.1', code: 'custom', message: 'slot "x" is listed twice' },
      { path: 'forms.a.hooks.1', code: 'custom', message: 'hook "onSummaryRead" is listed twice' },
      { path: 'forms.a.hooks', code: 'custom', message: 'every form needs a "complete" hook: it says what the form does once its slots are full' },
    ]);
  });

  it('an informational intent without a prompt, a missing control intent and a repeated menu digit are each named', () => {
    expect(issuesOf('intents', 'intents:\n  info: { criteria: c, label: l, kind: informational }\nmenu:\n  - { digit: "1", intent: info }\n  - { digit: "1", intent: info }\n')).toEqual([
      { path: 'intents.info', code: 'custom', message: 'an informational intent plays a prompt or says a passage, and this one names neither' },
      { path: 'intents', code: 'custom', message: 'the control intent "agent" is missing: the engine reads it by name' },
      { path: 'intents', code: 'custom', message: 'the control intent "repeat_prompt" is missing: the engine reads it by name' },
      { path: 'menu.1.digit', code: 'custom', message: 'keypad digit "1" is assigned twice' },
    ]);
  });

  it('an unquoted keypad digit is a number, which is refused', () => {
    expect(issuesOf('intents', 'intents:\n  agent: { criteria: c, label: l, kind: control }\n  repeat_prompt: { criteria: c, label: l, kind: control }\nmenu:\n  - { digit: 1, intent: agent }\n')).toMatchObject([
      { path: 'menu.0.digit', code: 'invalid_type' },
    ]);
  });

  it('a prompt mode other than fixed is refused', () => {
    expect(issuesOf('prompts', 'prompts:\n  hello: { text: Hi, interruptible: true, mode: generated }\n')).toEqual([
      { path: 'prompts.hello.mode', code: 'invalid_value', message: 'Invalid input: expected "fixed"' },
    ]);
  });

  it('policy levels, attempts and role access are bounded', () => {
    const fresh = issuesOf('policy', 'actions:\n  a:\n    level: 3\n    rules:\n      - role: { clerk: allowed }\n');
    expect(fresh.map((i) => `${i.path} ${i.code}`)).toEqual(['actions.a.level invalid_value', 'actions.a.rules.0.role.clerk invalid_value']);
    const identity = issuesOf('identity', 'principals: { subject: patient }\nlevels:\n  1: { name: a, factors: [x], verify: v }\n  2: { name: b, factors: [{ otp: { length: 2 } }], send: s, verify: c }\nattempts: 0\nsignIn: { level: 3 }\n');
    expect(identity.map((i) => `${i.path} ${i.code}`)).toEqual(['levels.2.factors.0.otp.length too_small', 'attempts too_small', 'signIn.level invalid_value']);
  });

  it('a spoken-digits pattern must compile, and a lead rule needs two capture groups', () => {
    expect(issuesOf('app', "id: x\nvoice:\n  spokenDigits:\n    - { pattern: '(oops', spell: groups }\n")).toMatchObject([
      { path: 'voice.spokenDigits.0.pattern', code: 'custom', message: expect.stringContaining('is not a valid regular expression') },
    ]);
    expect(issuesOf('app', "id: x\nvoice:\n  spokenDigits:\n    - { pattern: '\\d+', spell: lead }\n")).toEqual([
      {
        path: 'voice.spokenDigits.0.pattern',
        code: 'custom',
        message: 'a "lead" rule needs two capture groups (the words before the digits, then the digits), and this pattern has 0',
      },
    ]);
    expect(issuesOf('app', "id: x\nvoice:\n  spokenDigits:\n    - { pattern: '(parcel )(\\d+)', spell: lead }\n")).toEqual([]);
  });

  it('a console link may not open a javascript: address', () => {
    const link = 'id: x\nconsole:\n  links:\n    - { id: chat, label: Chat, title: Chat, href: "javascript:alert(1)", target: t, features: f }\n';
    expect(issuesOf('app', link)).toMatchObject([{ path: 'console.links.0.href', code: 'custom', message: 'href must be a path starting with "/" or an http(s) address' }]);
  });

  it('a __proto__ key is an unknown key, not a way to change what a file means', () => {
    const fresh = issuesOf('policy', 'actions: {}\n__proto__: { polluted: true }\n');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ code: 'unrecognized_keys' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the JSON Schemas', () => {
  const generated = jsonSchemas();

  for (const kind of FILE_KINDS) {
    it(`schemas/${kind}.schema.json is up to date (run: pnpm --filter dialogwright schemas)`, () => {
      const committed = readFileSync(join(SCHEMAS_DIR, `${kind}.schema.json`), 'utf8');
      expect(committed, `schemas/${kind}.schema.json is stale: run \`pnpm --filter dialogwright schemas\` and commit the result`).toBe(serializeSchema(generated[kind]));
    });
  }

  it('schemas/slots.schema.json is up to date (run: pnpm --filter dialogwright schemas)', () => {
    const committed = readFileSync(join(SCHEMAS_DIR, 'slots.schema.json'), 'utf8');
    expect(committed, 'schemas/slots.schema.json is stale: run `pnpm --filter dialogwright schemas` and commit the result').toBe(serializeSchema(slotsJsonSchema()));
  });

  it('schemas/locale-slots.schema.json is up to date (run: pnpm --filter dialogwright schemas)', () => {
    const committed = readFileSync(join(SCHEMAS_DIR, 'locale-slots.schema.json'), 'utf8');
    expect(committed, 'schemas/locale-slots.schema.json is stale: run `pnpm --filter dialogwright schemas` and commit the result').toBe(serializeSchema(localeSlotsJsonSchema()));
  });

  for (const [name, schema] of Object.entries(kbJsonSchemas())) {
    it(`schemas/${name}.schema.json is up to date (run: pnpm --filter dialogwright schemas)`, () => {
      const committed = readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8');
      expect(committed, `schemas/${name}.schema.json is stale: run \`pnpm --filter dialogwright schemas\` and commit the result`).toBe(serializeSchema(schema));
    });
  }

  it('the knowledge base has a JSON Schema for each kind of file it reads', () => {
    expect(Object.keys(kbJsonSchemas()).sort()).toEqual(['kb-locale-topics', 'kb-passage', 'kb-pending', 'kb-settings', 'kb-source', 'kb-topics']);
  });

  it('slots.yaml: the outer shape is a map of ids to maps with a type, and each type\'s options are the type\'s to check', () => {
    expect(slotsSchema.safeParse(parse('book: { type: code }\nnote: { type: text, what: a note, anything: 1 }\n')).success).toBe(true);
    expect(slotsSchema.safeParse(parse('book: { what: a note }\n')).success).toBe(false);
    expect(slotsSchema.safeParse(parse('"a book": { type: code }\n')).success).toBe(false);
    expect(slotsSchema.safeParse(parse('- book\n')).success).toBe(false);
  });

  it('describe every field, so an editor or an assistant can say what it is for', () => {
    const undescribed: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const n = node as { properties?: Record<string, { description?: string }>; items?: unknown; additionalProperties?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
      for (const [key, child] of Object.entries(n.properties ?? {})) {
        if (!child.description) undescribed.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
      walk(n.items, `${path}[]`);
      walk(n.additionalProperties, `${path}{}`);
      for (const branch of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) walk(branch, path);
    };
    for (const kind of FILE_KINDS) walk(generated[kind], kind);
    walk(slotsJsonSchema(), 'slots');
    walk(localeSlotsJsonSchema(), 'locale-slots');
    expect(undescribed).toEqual([]);
  });

  it('refuse unknown keys (additionalProperties: false) at the top of every file', () => {
    for (const kind of FILE_KINDS) expect(generated[kind].additionalProperties, kind).toBe(false);
  });

  it('mark what an author may leave out as optional: defaults are not required', () => {
    const policy = generated.policy as { required: string[] };
    expect(policy.required).toEqual(['actions']);
    const identity = generated.identity as { required: string[] };
    expect(identity.required).toEqual(['principals', 'levels', 'attempts']);
  });
});

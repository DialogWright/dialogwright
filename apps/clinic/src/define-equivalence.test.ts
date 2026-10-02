import { describe, expect, it } from 'vitest';
import { newSession, VOICE_RELAY, type App } from 'dialogwright';
import { clinicApp as yamlApp } from './app';
import { tsClinicApp as tsApp } from './legacyApp';

/**
 * The clinic built from its folder (app.ts: the YAML and the code, through defineApp) against the
 * clinic as the TypeScript tables assembled it (legacyApp.ts), field by field. Only the fields the
 * folder adds are left out: configHashes (always set by defineApp) and locales (app.yaml's locale).
 */
const NEW_FIELDS = ['configHashes', 'locales'];

/** Fields that are the code itself: the same objects in both builds. */
const CODE_FIELDS = ['slots', 'tools', 'facts', 'questions', 'testing'];

/** Functions the two builds each write as their own closure: compared by what they return. */
const CALLED = ['systems', 'callerState'];

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

/**
 * A value as plain data, keys in their order: each function becomes "[function]" and is collected
 * by its path, and a RegExp becomes its source and flags, so two builds compare in full, order included.
 */
function plain(value: unknown, path: string, fns: Map<string, unknown>): Plain {
  if (typeof value === 'function') {
    fns.set(path, value);
    return '[function]';
  }
  if (value instanceof RegExp) return { regexp: value.source, flags: value.flags, lastIndex: value.lastIndex };
  if (Array.isArray(value)) return value.map((v, i) => plain(v, `${path}[${i}]`, fns));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v, `${path}.${k}`, fns)]));
  }
  return value as Plain;
}

function dataOf(app: App): { data: Record<string, Plain>; fns: Map<string, unknown> } {
  const fns = new Map<string, unknown>();
  const data: Record<string, Plain> = {};
  for (const [key, value] of Object.entries(app)) {
    if (NEW_FIELDS.includes(key) || CODE_FIELDS.includes(key) || value === undefined) continue;
    data[key] = plain(value, key, fns);
  }
  return { data, fns };
}

describe('the clinic built from its folder is the clinic the TypeScript tables built', () => {
  it('has the same fields, and only the folder\'s own beside them', () => {
    const keys = (app: App) => Object.keys(app).filter((k) => (app as unknown as Record<string, unknown>)[k] !== undefined);
    expect(keys(yamlApp).filter((k) => !NEW_FIELDS.includes(k)).sort()).toEqual(keys(tsApp).sort());
    expect(yamlApp.configHashes).toBeDefined();
    expect(yamlApp.locales).toEqual({ default: 'en-US', prompts: {} });
    expect(tsApp.locales).toBeUndefined();
  });

  it('has the same code: slots, tools, facts, questions and the test hooks are the same objects', () => {
    for (const key of CODE_FIELDS) expect((yamlApp as unknown as Record<string, unknown>)[key], key).toBe((tsApp as unknown as Record<string, unknown>)[key]);
  });

  it('has the same data, field by field and in the same order: intents, menu, forms, policy, prompts, presentation, wording, thresholds, carried slots, fixtures', () => {
    const yaml = dataOf(yamlApp).data;
    const ts = dataOf(tsApp).data;
    for (const key of Object.keys(ts)) expect(yaml[key], key).toEqual(ts[key]);
    // toEqual ignores key order; the model is offered intents (and options) in their order, so compare that too.
    for (const key of Object.keys(ts)) expect(JSON.stringify(yaml[key]), key).toBe(JSON.stringify(ts[key]));
  });

  it('pins what the model is sent: the intents in order with their criteria and labels, the wording, every line', () => {
    expect(Object.keys(yamlApp.intents)).toEqual(Object.keys(tsApp.intents));
    for (const [id, def] of Object.entries(tsApp.intents)) expect(yamlApp.intents[id], id).toStrictEqual(def);
    expect(yamlApp.wording).toStrictEqual(tsApp.wording);
    expect(Object.keys(yamlApp.prompts.manifest)).toEqual(Object.keys(tsApp.prompts.manifest));
    for (const [id, line] of Object.entries(tsApp.prompts.manifest)) expect(yamlApp.prompts.manifest[id], id).toStrictEqual(line);
    expect(yamlApp.prompts.tags).toStrictEqual(tsApp.prompts.tags);
  });

  it('compiles the spoken-digits pattern to the same regular expression, and spells the same', () => {
    const [a] = yamlApp.voice!.spokenDigits!;
    const [b] = tsApp.voice!.spokenDigits!;
    expect(yamlApp.voice!.spokenDigits).toHaveLength(1);
    expect([a!.pattern.source, a!.pattern.flags, a!.spell]).toEqual([b!.pattern.source, b!.pattern.flags, b!.spell]);
    for (const text of ['member ID 5550 7788', 'call 55507788 now', '1234', 'A1001 and 4471 8293 1234']) {
      expect(text.match(a!.pattern), text).toEqual(text.match(b!.pattern));
    }
  });

  it('has the same hooks: every function the data holds is the same function, but for the two closures each build writes, which return the same', () => {
    const yaml = dataOf(yamlApp).fns;
    const ts = dataOf(tsApp).fns;
    expect([...yaml.keys()].sort()).toEqual([...ts.keys()].sort());
    for (const [path, fn] of ts) {
      if (CALLED.includes(path)) continue;
      expect(yaml.get(path), path).toBe(fn);
    }
    // Each form's hooks, by name, as the engine reads them.
    expect(Object.keys(yamlApp.forms)).toEqual(Object.keys(tsApp.forms));
    for (const [id, form] of Object.entries(tsApp.forms)) {
      expect(Object.keys(yamlApp.forms[id]!).sort(), id).toEqual(Object.keys(form).sort());
      for (const [hook, fn] of Object.entries(form)) if (typeof fn === 'function') expect((yamlApp.forms[id] as unknown as Record<string, unknown>)[hook], `${id}.${hook}`).toBe(fn);
    }
    // The systems: a fresh copy each, equal, with the same lookups.
    const ys = yamlApp.systems();
    const tsys = tsApp.systems();
    expect(ys.sys).toEqual(tsys.sys);
    expect(ys.sys).not.toBe(tsys.sys);
    expect(ys.lookups).toBe(tsys.lookups);
    // The caller state the model is told.
    const s = newSession('CA-equivalence', 0, VOICE_RELAY);
    expect(yamlApp.callerState!(s)).toEqual(tsApp.callerState!(s));
  });

  it('words the gate\'s role line the same for every role, tool and access (a template in policy.yaml, a function in TypeScript)', () => {
    const a = yamlApp.policy.wording?.role;
    const b = tsApp.policy.wording?.role;
    expect(typeof a).toBe(typeof b);
    if (!a || !b) return; // The clinic has no roles: neither build words a role line.
    const roles = [...new Set(Object.values(tsApp.policy.roles ?? {}).flatMap((r) => Object.keys(r))), 'clerk'];
    for (const role of roles) for (const tool of Object.keys(tsApp.tools)) for (const access of ['allow', 'refuse', 'person'] as const) {
      expect(a(role, tool, access)).toBe(b(role, tool, access));
    }
  });
});

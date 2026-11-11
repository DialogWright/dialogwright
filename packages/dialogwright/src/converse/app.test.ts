import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessCalendar, defineConverseApp, isConverseApp } from './app';
import { AgentBusinessError } from './business/load';
import type { ToolImpl } from './turn';

/** A converse app: its folder's agent.yaml joined with the code of each action it names. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'business', 'fixture', 'agent.yaml');
const noop: ToolImpl = async () => 'ok';
const APP_YAML = '# yaml-language-server: $schema=../schemas/app.schema.json\nid: example\nmode: converse\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'converse-app-'));
  copyFileSync(FIXTURE, join(dir, 'agent.yaml'));
  writeFileSync(join(dir, 'app.yaml'), APP_YAML);
  vi.stubEnv('OFFICE_LINE', '+15555550100');
});
afterEach(() => vi.unstubAllEnvs());

describe('defineConverseApp', () => {
  it('joins the business with the code of every action, named by its app.yaml', () => {
    const app = defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } });
    expect(app).toMatchObject({ mode: 'converse', id: 'example', dir });
    expect(app.id).not.toBe(basename(dir));
    expect(Object.keys(app.business.actions)).toEqual(['availability', 'book', 'notify']);
    expect(Object.keys(app.tools)).toEqual(['availability', 'book', 'notify']);
  });

  it('refuses an action with no code, and code for no action', () => {
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop } })).toThrow(/"notify" has no code/);
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop, cancel: noop } })).toThrow(/"cancel" is no action/);
    try {
      defineConverseApp(dir, { tools: { availability: noop } });
    } catch (e) {
      expect(e).toBeInstanceOf(AgentBusinessError);
      expect((e as AgentBusinessError).problems.map((p) => p.path)).toEqual(['actions.book', 'actions.notify']);
    }
  });

  it('refuses a follow-on that takes a param its parent does not have', () => {
    const text = readFileSync(FIXTURE, 'utf8').replace('      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }', '      item: { type: choice, options: [kettle, toaster, lamp], about: The item. }\n      note: { type: text, about: A note. }');
    writeFileSync(join(dir, 'agent.yaml'), text);
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } })).toThrow(/"notify" takes note, which "book" has not/);
  });

  it('refuses rules the gate cannot hold', () => {
    const text = readFileSync(FIXTURE, 'utf8').replace('      - oneOf: { field: item,', '      - oneOf: { field: thing,');
    writeFileSync(join(dir, 'agent.yaml'), text);
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } })).toThrow(/"thing" is no param of "book"/);
  });
});

describe('a converse app\'s app.yaml', () => {
  const tools = { availability: noop, book: noop, notify: noop };

  it('is required, says mode: converse, and is read by app.yaml\'s own schema', () => {
    rmSync(join(dir, 'app.yaml'));
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml cannot be read/);
    writeFileSync(join(dir, 'app.yaml'), 'id: example\n');
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml:1:1  mode  a converse app's app\.yaml says "mode: converse", and this one names no mode/);
    writeFileSync(join(dir, 'app.yaml'), 'id: example\nmode: agent\n');
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml:2:7  mode  a converse app's app\.yaml says "mode: converse", and this one says "agent"/);
    writeFileSync(join(dir, 'app.yaml'), 'id: Example App\nmode: converse\n');
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml:1:5  id  /);
    writeFileSync(join(dir, 'app.yaml'), 'id: example\nmode: converse\nchats: {}\n');
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml:3:1  chats/);
  });

  it('takes no caller number from a chat\'s context by default', () => {
    expect(defineConverseApp(dir, { tools }).chat).toEqual({ callerNumberFromContext: false });
  });

  it('takes one where it says chat.callerNumberFromContext: true, and refuses a value that is not true or false', () => {
    writeFileSync(join(dir, 'app.yaml'), `${APP_YAML}chat:\n  callerNumberFromContext: true\n`);
    const app = defineConverseApp(dir, { tools });
    expect(app.chat).toEqual({ callerNumberFromContext: true });
    expect(isConverseApp(app)).toBe(true);
    expect(isConverseApp({ id: 'scripted' })).toBe(false);
    writeFileSync(join(dir, 'app.yaml'), `${APP_YAML}chat:\n  callerNumberFromContext: sometimes\n`);
    expect(() => defineConverseApp(dir, { tools })).toThrow(/app\.yaml:5:28  chat\.callerNumberFromContext  "callerNumberFromContext" must be true or false/);
  });
});

describe('businessCalendar', () => {
  it('takes today in the business\'s zone, the same zone the turn checks dates in', async () => {
    const app = defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } });
    const b = { ...app.business, sources: { calendar: { kind: 'fake' as const, days: ['monday', 'tuesday', 'wednesday'], windows: [{ name: 'morning', label: '9 to 12', capacity: 1 }] } } };
    // 02:00 UTC on the 12th is still the 11th in the business's zone (America/New_York).
    const calendar = businessCalendar(b, () => new Date('2026-11-12T02:00:00Z'))!;
    expect((await calendar.free('2026-11-11')).map((s) => s.id)).toEqual(['2026-11-11:morning']);
  });

  it('is null for a business with no calendar', () => {
    const app = defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } });
    expect(businessCalendar({ ...app.business, sources: {} }, () => new Date())).toBeNull();
  });
});

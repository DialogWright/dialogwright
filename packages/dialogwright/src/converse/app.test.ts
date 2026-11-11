import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessCalendar, defineConverseApp } from './app';
import { AgentBusinessError } from './business/load';
import type { ToolImpl } from './turn';

/** A converse app: its folder's agent.yaml joined with the code of each action it names. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'business', 'fixture', 'agent.yaml');
const noop: ToolImpl = async () => 'ok';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'converse-app-'));
  copyFileSync(FIXTURE, join(dir, 'agent.yaml'));
  vi.stubEnv('OFFICE_LINE', '+15555550100');
});
afterEach(() => vi.unstubAllEnvs());

describe('defineConverseApp', () => {
  it('joins the business with the code of every action, named by its folder', () => {
    const app = defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } });
    expect(app).toMatchObject({ mode: 'converse', id: basename(dir), dir });
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
    const text = readFileSync(FIXTURE, 'utf8').replace('      item: { type: text, about: The item. }', '      item: { type: text, about: The item. }\n      note: { type: text, about: A note. }');
    writeFileSync(join(dir, 'agent.yaml'), text);
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } })).toThrow(/"notify" takes note, which "book" has not/);
  });

  it('refuses rules the gate cannot hold', () => {
    const text = readFileSync(FIXTURE, 'utf8').replace('      - oneOf: { field: item,', '      - oneOf: { field: thing,');
    writeFileSync(join(dir, 'agent.yaml'), text);
    expect(() => defineConverseApp(dir, { tools: { availability: noop, book: noop, notify: noop } })).toThrow(/"thing" is no param of "book"/);
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

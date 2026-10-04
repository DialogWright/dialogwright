import { beforeAll, describe, expect, it } from 'vitest';
import { useTestkit } from '../../testing/apps';
import { testkitApp } from '../../testing/testkit';
import { serviceResultEvent } from '../../channel/events';
import { VOICE_RELAY } from '../../channel/caps';
import { auditDrafts } from '../audit';
import { newSession } from '../session';
import type { KbSource } from '../lifecycle';
import { kbAuditRow } from '../../kb/record';
import { registerApp } from './registry';
import type { ServiceDef, App } from './types';

/**
 * Audit rows and downstream services are the app's: the engine records a tool by its own hook or, without
 * one, by its summary, and an agent's answer by the agent's own row. Run against small apps that are
 * not the testkit (its tables and prompts, its tools stripped of their audit hooks). How the server
 * asks an agent is src/server/services.test.ts.
 */
useTestkit();

const bare: App = {
  ...testkitApp,
  id: 'audit-bare',
  // No audit hooks; the fields the testkit's policy withholds from its delegates stay declared.
  tools: Object.fromEntries(Object.entries(testkitApp.tools).map(([k, t]) => [k, t.fields ? { run: t.run, fields: t.fields } : { run: t.run }])),
  services: undefined,
};

const scout: ServiceDef = {
  resolve: async (params, { url }) => serviceResultEvent('scout', { url, seen: Object.keys(params) }),
  fromLog: (r) => r,
  audit: (result) => ({ type: 'scout_answer', detail: { answered: result !== null } }),
};
const hooked: App = {
  ...bare,
  id: 'audit-hooked',
  tools: { ...bare.tools, lookUp: { run: () => ({ value: null, summary: 'looked' }), audit: ({ call, summary, ref }) => [{ type: 'looked_up', detail: { tool: call.tool, summary, ref: ref ?? null } }] } },
  services: { scout, rival: { ...scout, audit: () => ({ type: 'rival_answer', detail: {} }) } },
};

// A tool that resolves a passage records the answer with the engine's row (kb/record.ts kbAuditRow).
const answering: App = {
  ...bare,
  id: 'audit-answering',
  tools: { ...bare.tools, lookUp: { run: () => ({ value: null, summary: 'found' }), audit: ({ call, summary, kb }) => [{ type: 'tool_result', detail: { tool: call.tool, summary } }, ...(kb ? [kbAuditRow(kb)] : [])] } },
};

beforeAll(() => {
  registerApp(bare);
  registerApp(hooked);
  registerApp(answering);
});

/** A gate event that allowed `tool`, as the audit reads one. */
function ran(tool: string, summary: string, ref?: string) {
  return { decision: { call: { tool, params: { a: '1' } }, verdict: 'ALLOW' as const, rules: [] }, summary, ...(ref !== undefined ? { ref } : {}) };
}

function drafts(appId: string, gateEvents: ReturnType<typeof ran>[], event = serviceResultEvent('scout', null), pendingService: string | null = null, kb: KbSource | null = null) {
  const s = { ...newSession('a', 0, VOICE_RELAY, undefined, appId), pendingService };
  return auditDrafts({ before: s, after: s, event, decision: { kind: 'ignore' }, gateEvents, kb, screen: null, quarantined: false });
}

describe('audit rows from the app', () => {
  it('a tool with no audit hook is recorded by its one-line summary, whatever its name', () => {
    const rows = drafts('audit-bare', [ran('verifyCustomer', 'verified'), ran('createReport', 'report 9001', '9001')]).filter((d) => d.type !== 'gate');
    expect(rows).toEqual([
      { type: 'tool_result', detail: { tool: 'verifyCustomer', summary: 'verified' } },
      { type: 'tool_result', detail: { tool: 'createReport', summary: 'report 9001' } },
    ]);
  });

  it('a tool\'s own audit hook gives its rows in place of the summary', () => {
    const rows = drafts('audit-hooked', [ran('lookUp', 'looked', 'r9')]).filter((d) => d.type !== 'gate');
    expect(rows).toEqual([{ type: 'looked_up', detail: { tool: 'lookUp', summary: 'looked', ref: 'r9' } }]);
  });

  it('a tool\'s hook is given the turn\'s knowledge record, and kbAuditRow records it', () => {
    const kb: KbSource = {
      passageId: 'terms-2026', topic: 'terms', version: '2026.1', applies: { tier: 'standard' }, locale: 'en-US', document: 'Terms', section: '2',
      effectiveFrom: '2026-01-01', approvedBy: 'legal', approvedOn: '2025-12-15', sourceHash: '18345c153386', approvalHash: '7ae3662c7794', fresh: true,
    };
    expect(drafts('audit-answering', [ran('lookUp', 'found')], undefined, null, kb).filter((d) => d.type !== 'gate')).toEqual([
      { type: 'tool_result', detail: { tool: 'lookUp', summary: 'found' } },
      { type: 'kb_answer', detail: { passageId: 'terms-2026', version: '2026.1', fresh: true, locale: 'en-US', sourceHash: '18345c153386', approvalHash: '7ae3662c7794' } },
    ]);
    expect(drafts('audit-answering', [ran('lookUp', 'found')]).filter((d) => d.type !== 'gate')).toEqual([{ type: 'tool_result', detail: { tool: 'lookUp', summary: 'found' } }]);
  });

  it('an awaited agent\'s answer is recorded by the agent\'s own row; none for an agent the app lacks or when nothing was awaited', () => {
    expect(drafts('audit-hooked', [], serviceResultEvent('scout', { x: 1 }), 'scout')).toEqual([{ type: 'scout_answer', detail: { answered: true } }]);
    expect(drafts('audit-hooked', [], serviceResultEvent('other', { x: 1 }), 'scout')).toEqual([]);
    expect(drafts('audit-hooked', [], serviceResultEvent('scout', { x: 1 }), null)).toEqual([]);
    // An answer from a different declared agent than the one the call asked is not recorded as its answer.
    expect(drafts('audit-hooked', [], serviceResultEvent('rival', { x: 1 }), 'scout')).toEqual([]);
    expect(drafts('audit-bare', [], serviceResultEvent('depot', null), 'depot')).toEqual([]);
  });
});

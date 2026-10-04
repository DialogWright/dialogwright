import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { KbSource } from '../core/lifecycle';
import { loadKnowledgeFolder } from '../define/load';
import { KB_SHORT_HASH, kbAuditRow, kbSourceOf, shortHash } from './record';
import { resolvePassage } from './resolve';
import type { KbPassage, KnowledgeBase } from './types';

/**
 * The knowledge record (core/lifecycle.ts KbSource) built from the library fixture's passages
 * (./__fixtures__/kb), and its audit row: the shape a trace, a tool's audit hook and the console
 * read, field for field.
 */

const KB_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'kb');
const TODAY = '2026-10-03';

function fixtureKb(): KnowledgeBase {
  const folder = loadKnowledgeFolder(KB_FIXTURE, 'en-US');
  expect(folder.problems).toEqual([]);
  return folder.kb!;
}

describe('the knowledge record', () => {
  const kb = fixtureKb();

  it('short hashes are the first 12 hex characters of the digest', () => {
    expect(KB_SHORT_HASH).toBe(12);
    expect(shortHash('18345c1533866b482125f9f1f66d537d51741e4c0fce296322696bf920018b6a')).toBe('18345c153386');
    // Already short: unchanged.
    expect(shortHash('18345c153386')).toBe('18345c153386');
  });

  it('a resolved passage: whom it answered (only the facts it depends on), its locale, its effective days, its approval and short digests', () => {
    const r = resolvePassage(kb, { topic: 'late_fees', facts: { card: 'junior', branch: 'east' }, todayIso: TODAY });
    expect('fresh' in r && r.fresh).toBe(true);
    const source = kbSourceOf(r.passage!, { applies: { card: 'junior', branch: 'east' }, fresh: true });
    expect(source).toEqual({
      passageId: 'late-fees-junior', topic: 'late_fees', version: '2026.1', applies: { card: 'junior' }, locale: 'en-US',
      document: 'patron-guide', section: '3.2', effectiveFrom: '2026-01-01',
      approvedBy: 'Branch Manager', approvedOn: '2025-12-10', sourceHash: '18345c153386', approvalHash: '7ae3662c7794', fresh: true,
    } satisfies KbSource);
    // A record is JSON in the trace: it reads back as it was written.
    expect(JSON.parse(JSON.stringify(source))).toEqual(source);
  });

  it('a closed range keeps its last day; a translation its own locale; the document can be named by its title', () => {
    expect(kbSourceOf(kb.passages['late-fees-adult-2025']!, { applies: { card: 'adult' } })).toMatchObject({
      applies: { card: 'adult' }, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31', sourceHash: 'a14e5fbd6225', approvalHash: '3314a131c309', fresh: true,
    });
    const es = kbSourceOf(kb.passages['opening-hours-es']!, { applies: {}, document: kb.sources['patron-guide']!.document });
    expect(es).toMatchObject({ passageId: 'opening-hours-es', applies: {}, locale: 'es', document: 'Example Town Library Patron Guide', section: '1.1' });
    expect(es).not.toHaveProperty('effectiveTo');
    expect(kbSourceOf(kb.passages['opening-hours']!, { applies: {}, locale: 'en-GB' }).locale).toBe('en-GB');
  });

  it('a passage with no approval: no approver and no digests, and not fresh', () => {
    const p = kb.passages['late-fees-junior']!;
    const unapproved: KbPassage = { ...p, approval: undefined, freshness: 'unapproved' };
    const source = kbSourceOf(unapproved, { applies: { card: 'junior' } });
    expect(source.fresh).toBe(false);
    for (const field of ['approvedBy', 'approvedOn', 'sourceHash', 'approvalHash'] as const) expect(source).not.toHaveProperty(field);
    // `fresh` given wins over the passage's own freshness (the resolver's answer is the one that counts).
    expect(kbSourceOf(p, { applies: { card: 'junior' }, fresh: false }).fresh).toBe(false);
  });

  it('never carries the deprecated plan', () => {
    expect(kbSourceOf(kb.passages['late-fees-junior']!, { applies: { card: 'junior' } })).not.toHaveProperty('plan');
  });
});

describe('the knowledge audit row', () => {
  const kb = fixtureKb();

  it('kb_answer: the passage, its version and freshness, its locale and short digests; nothing of whom it answered', () => {
    const row = kbAuditRow(kbSourceOf(kb.passages['late-fees-junior']!, { applies: { card: 'junior' } }));
    expect(row).toEqual({
      type: 'kb_answer',
      detail: { passageId: 'late-fees-junior', version: '2026.1', fresh: true, locale: 'en-US', sourceHash: '18345c153386', approvalHash: '7ae3662c7794' },
    });
  });

  it('a record with no locale or digests gives only the passage, version and freshness; a full digest is shortened', () => {
    const bare: KbSource = { passageId: 'p', topic: 't', version: '1', applies: { tier: 'a' }, document: 'd', section: 's', effectiveFrom: '2026-01-01', fresh: false };
    expect(kbAuditRow(bare)).toEqual({ type: 'kb_answer', detail: { passageId: 'p', version: '1', fresh: false } });
    const full = 'd1c33fb7afe5645cca5071b0ff08aad71dc559cf188a9b8f3513046264a46d2e';
    expect(kbAuditRow({ ...bare, sourceHash: full }).detail.sourceHash).toBe('d1c33fb7afe5');
  });
});

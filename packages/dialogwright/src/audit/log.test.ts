import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, GENESIS } from './log';
import { verifyChain } from './verify';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audit-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('AuditLog', () => {
  it('chains entries and verifies', () => {
    const log = new AuditLog(dir, () => Date.UTC(2026, 9, 1, 17, 0, 0));
    const a = log.append('CA1', 'voice', { type: 'call_started', detail: {} });
    const b = log.append('CA1', 'voice', { type: 'gate', detail: { tool: 'getParcel', verdict: 'BLOCK' } });
    expect(a.prevHash).toBe(GENESIS);
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(a.seq + 1);
    expect(verifyChain(log.path)).toEqual({ ok: true, entries: 2 });
  });

  it('continues the chain across instances on the same file', () => {
    const now = () => Date.UTC(2026, 9, 1);
    const first = new AuditLog(dir, now).append('CA1', 'voice', { type: 'call_started', detail: {} });
    const second = new AuditLog(dir, now).append('CA2', 'chat', { type: 'call_started', detail: {} });
    expect(second.prevHash).toBe(first.hash);
  });

  it('rolls over to a new day file, and a new chain, at midnight UTC', () => {
    let t = Date.UTC(2026, 9, 1, 23, 59, 0);
    const log = new AuditLog(dir, () => t);
    const late = log.append('CA1', 'voice', { type: 'call_started', detail: {} });
    const lateAgain = log.append('CA1', 'voice', { type: 'gate', detail: { verdict: 'ALLOW' } });
    const firstDay = log.path;
    t = Date.UTC(2026, 9, 2, 0, 0, 30);
    const early = log.append('CA1', 'voice', { type: 'call_ended', detail: { reason: 'hangup' } });
    expect(log.path).not.toBe(firstDay);
    expect(log.path).toBe(join(dir, '2026-10-02.jsonl'));
    // The new day's chain starts from GENESIS and its seq from 1, the old day's is left whole.
    expect(early).toMatchObject({ seq: 1, prevHash: GENESIS, at: '2026-10-02T00:00:30.000Z' });
    expect(lateAgain).toMatchObject({ seq: 2, prevHash: late.hash });
    expect(verifyChain(firstDay)).toEqual({ ok: true, entries: 2 });
    expect(verifyChain(log.path)).toEqual({ ok: true, entries: 1 });
    // A second entry on the new day links to the first of that day.
    expect(log.append('CA2', 'voice', { type: 'call_started', detail: {} })).toMatchObject({ seq: 2, prevHash: early.hash });
  });

  it('verifies a day written with the rules\' legacy ids and the day after it written with their names: the chain does not read a rule line', () => {
    let t = Date.UTC(2026, 9, 2, 12, 0, 0);
    const log = new AuditLog(dir, () => t);
    const before = log.append('CA1', 'voice', { type: 'gate', detail: { tool: 'getParcel', verdict: 'BLOCK', rules: ['R1 pass: identity.level 2 >= 2', 'R2 fail: record owner ...5678 · caller may see ...1234 only'] } });
    const firstDay = log.path;
    t = Date.UTC(2026, 9, 3, 12, 0, 0);
    const after = log.append('CA2', 'voice', { type: 'gate', detail: { tool: 'getParcel', verdict: 'BLOCK', rules: ['identity pass: identity.level 2 >= 2', 'scope fail: record owner ...5678 · caller may see ...1234 only'] } });
    expect(log.path).not.toBe(firstDay);
    expect(before.detail.rules).toEqual(['R1 pass: identity.level 2 >= 2', 'R2 fail: record owner ...5678 · caller may see ...1234 only']);
    expect(after.detail.rules).toEqual(['identity pass: identity.level 2 >= 2', 'scope fail: record owner ...5678 · caller may see ...1234 only']);
    expect(verifyChain(firstDay)).toEqual({ ok: true, entries: 1 });
    expect(verifyChain(log.path)).toEqual({ ok: true, entries: 1 });
  });

  it('finds the first tampered line', () => {
    const log = new AuditLog(dir, () => Date.UTC(2026, 9, 1));
    log.append('CA1', 'voice', { type: 'call_started', detail: {} });
    log.append('CA1', 'voice', { type: 'gate', detail: { verdict: 'BLOCK' } });
    log.append('CA1', 'voice', { type: 'call_ended', detail: {} });
    const lines = readFileSync(log.path, 'utf8').trim().split('\n');
    lines[1] = lines[1]!.replace('BLOCK', 'ALLOW');
    writeFileSync(log.path, lines.join('\n') + '\n');
    expect(verifyChain(log.path)).toEqual({ ok: false, entries: 3, brokenAt: 2, why: 'hash mismatch' });
  });

  it('finds a deleted line: the entry after it no longer links to the one before', () => {
    const log = new AuditLog(dir, () => Date.UTC(2026, 9, 1));
    log.append('CA1', 'voice', { type: 'call_started', detail: {} });
    log.append('CA1', 'voice', { type: 'gate', detail: { verdict: 'BLOCK' } });
    log.append('CA1', 'voice', { type: 'call_ended', detail: {} });
    const lines = readFileSync(log.path, 'utf8').trim().split('\n');
    lines.splice(1, 1);
    writeFileSync(log.path, lines.join('\n') + '\n');
    expect(verifyChain(log.path)).toEqual({ ok: false, entries: 2, brokenAt: 2, why: 'broken link' });
  });
});

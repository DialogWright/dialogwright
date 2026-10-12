import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from './pgliteSql';
import { NOTICE_KEEP_MS, PostgresNotices } from './notices';
import { DashboardBus, type PublishedEvent } from '../dashboard/bus';

/**
 * Notices between servers on one database: a row and a NOTIFY of its id, so a body of any size goes
 * through (a NOTIFY's payload stops at 8000 bytes); each server hears the others', never its own; one
 * that starts late hears nothing from before it; rows are swept after a while.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function pair(): Promise<{ db: PGlite; a: PostgresNotices; b: PostgresNotices }> {
  const db = await PGlite.create();
  closers.push(() => db.close());
  const a = await PostgresNotices.open(pgliteSql(db), { origin: 'a-1' });
  const b = await PostgresNotices.open(pgliteSql(db), { origin: 'b-2' });
  closers.push(() => a.close(), () => b.close());
  return { db, a, b };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('notices between servers on one Postgres', () => {
  it('each server hears the others\' notices of a topic, in order, never its own, whatever their size', async () => {
    const { a, b } = await pair();
    const heardByA: string[] = [];
    const heardByB: string[] = [];
    a.subscribe('chat', (body) => heardByA.push(body));
    b.subscribe('chat', (body, origin) => heardByB.push(`${origin}:${body.length > 100 ? `${body.length} chars` : body}`));
    a.publish('chat', 'one');
    a.publish('chat', 'x'.repeat(20_000));
    a.publish('other', 'not for chat');
    a.publish('chat', 'three');
    await until(() => heardByB.length === 3);
    expect(heardByB).toEqual(['a-1:one', 'a-1:20000 chars', 'a-1:three']);
    expect(heardByA).toEqual([]);
  });

  it('a server that starts late hears nothing sent before it; rows are swept once old', async () => {
    const db = await PGlite.create();
    closers.push(() => db.close());
    const a = await PostgresNotices.open(pgliteSql(db), { origin: 'a-1' });
    closers.push(() => a.close());
    a.publish('chat', 'early');
    await a.settled();
    const late = await PostgresNotices.open(pgliteSql(db), { origin: 'c-3' });
    closers.push(() => late.close());
    const heard: string[] = [];
    late.subscribe('chat', (body) => heard.push(body));
    a.publish('chat', 'later');
    await until(() => heard.length === 1);
    expect(heard).toEqual(['later']);
    expect(await a.sweep(Date.now() + NOTICE_KEEP_MS + 1)).toBe(2);
  });

  it("a console's bus linked through the notices sees the other server's events, redacted as they were published, numbered by its own bus", async () => {
    const { a, b } = await pair();
    const busA = new DashboardBus();
    const busB = new DashboardBus();
    busA.link((e) => a.publish('console', JSON.stringify(e)));
    busB.link((e) => b.publish('console', JSON.stringify(e)));
    a.subscribe('console', (body) => busA.receive(JSON.parse(body)));
    b.subscribe('console', (body) => busB.receive(JSON.parse(body)));
    const seenOnB: PublishedEvent[] = [];
    busB.subscribe((e) => seenOnB.push(e));
    busA.publish({ type: 'call_started', callSid: 'CA1', at: 1, from: '...0110', todayIso: '2026-10-11', thresholds: {} });
    busA.publish({ type: 'dtmf', callSid: 'CA1', at: 2, digit: '•' });
    await until(() => seenOnB.length === 2);
    expect(seenOnB.map((e) => [e.type, e.seq])).toEqual([['call_started', 1], ['dtmf', 2]]);
    expect(busB.current()).toBe('CA1');
    // B's own events reach A, and are not echoed back to B.
    const seenOnA: PublishedEvent[] = [];
    busA.subscribe((e) => seenOnA.push(e));
    busB.publish({ type: 'call_started', callSid: 'CA2', at: 3, from: '...0111', todayIso: '2026-10-11', thresholds: {} });
    await until(() => busA.current() === 'CA2');
    await new Promise((r) => setTimeout(r, 50));
    expect(seenOnB.filter((e) => e.callSid === 'CA2')).toHaveLength(1);
  });
});

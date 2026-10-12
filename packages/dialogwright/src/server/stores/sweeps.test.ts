import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgliteSql } from './pgliteSql';
import { openSweeps } from './sweeps';

/** One server runs a shared sweep at a time: the first to claim it holds it, by the database's clock, until its hold has passed. */

const dbs: PGlite[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.close();
});

describe('a sweep the servers share', () => {
  it('is taken by one server, refused to the others while held, and taken again once the hold has passed', async () => {
    const db = await PGlite.create();
    dbs.push(db);
    const a = await openSweeps(pgliteSql(db));
    const b = await openSweeps(pgliteSql(db));
    expect(await a.claim('traces', 'a-1', 200)).toBe(true);
    expect(await b.claim('traces', 'b-2', 200)).toBe(false);
    expect(await b.claim('other', 'b-2', 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(await b.claim('traces', 'b-2', 200)).toBe(true);
    expect(await a.claim('traces', 'a-1', 200)).toBe(false);
  });
});

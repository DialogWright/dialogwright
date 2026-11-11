import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaimsReading } from '../converse/claims';
import type { JsonValue } from '../jev/types';

/**
 * The cases file an evaluation writes with --claims-cases (`claims-cases.jsonl` in --out): what the check
 * after speaking was sent for each reply it read, kept so another set of questions can be measured on the same
 * replies offline (`dialogwright converse:claims-eval`). The first line is `{"v":1,"business":<text>}`; each
 * further line is one read reply, `{id, persona, run, turn, today, actions, reply, reading}`, the state's fields
 * without the business (the same for the whole run: it is written again before the cases it applies to if it
 * ever changes, and the reader takes the latest). It holds what was said on the calls, so it is never
 * published.
 */
export const CLAIMS_CASES_FILE = 'claims-cases.jsonl';

/** One reply the check read, as the hook tells it. */
export interface ClaimsRead {
  turn: number;
  state: JsonValue;
  reading: ClaimsReading | null;
}

/** The state the check is sent, as a case holds it. */
interface ClaimsStateParts {
  business: string;
  today: string;
  actions: JsonValue;
  reply: string;
}

const partsOf = (state: JsonValue): ClaimsStateParts | null => {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return null;
  const { business, today, actions, reply } = state;
  return typeof business === 'string' && typeof today === 'string' && typeof reply === 'string' && actions !== undefined ? { business, today, actions, reply } : null;
};

/** Collects each call's reads while it runs and writes them, with the call's persona and run, once it is done. */
export class ClaimsCases {
  private readonly reads = new Map<string, ClaimsRead[]>();
  private business: string | null = null;

  constructor(private readonly outDir: string) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, CLAIMS_CASES_FILE), '');
  }

  /** The hook the server is given (ServerOverrides.onClaimsRead). */
  readonly onClaimsRead = (callId: string, read: ClaimsRead): void => {
    const list = this.reads.get(callId);
    if (list === undefined) this.reads.set(callId, [read]);
    else list.push(read);
  };

  /** The call's reads written, in the order read, under the persona and run it was; none for a call that read nothing. */
  write(callId: string, persona: string, run: number): void {
    const list = this.reads.get(callId) ?? [];
    this.reads.delete(callId);
    const lines: string[] = [];
    for (const r of list) {
      const p = partsOf(r.state);
      if (p === null) continue;
      if (p.business !== this.business) {
        this.business = p.business;
        lines.push(JSON.stringify({ v: 1, business: p.business }));
      }
      lines.push(JSON.stringify({ id: `${persona}-${run}/t${r.turn}`, persona, run, turn: r.turn, today: p.today, actions: p.actions, reply: p.reply, reading: r.reading }));
    }
    if (lines.length > 0) appendFileSync(join(this.outDir, CLAIMS_CASES_FILE), `${lines.join('\n')}\n`);
  }
}

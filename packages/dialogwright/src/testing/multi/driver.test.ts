import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestkit } from '../apps';
import { inProcessStack, type InProcessStack } from './inProcess';
import { scriptFromScenario, serverOf, socketUrl, takeover, takeovers, TakeoverError, turnsAreWhole, repeatedResults, type CallScript } from './driver';
import type { AuditEntry } from '../../audit/types';

/**
 * The takeover driver `pnpm multi:test` runs against the compose stack's containers, run here against
 * two servers in this process with the same settings (MULTI_SERVER_ENV), on the testkit's call: so the
 * steps the compose run takes (find the server holding the call, make it go, reconnect, and every
 * check) are steps the suite has run. The testkit's delivery window, as the in-process two-server test
 * places it (server/manyServers.e2e.test.ts): the server goes after the account ID, with the birth date
 * asked.
 */

useTestkit();

const WINDOW: CallScript = {
  says: ['can you deliver tomorrow morning', 'five five five zero one two three four', 'april twelfth nineteen eighty five', "no, that's all"],
  goAfter: 2,
};

const stacks: InProcessStack[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function stack(): Promise<InProcessStack> {
  // A drain shorter than the compose stack's: this balancer sees a draining server at once.
  const s = await inProcessStack({ env: { DRAIN_MS: '500' }, ...(process.env.MULTI_SERVERS_DEBUG ? { log: (n: string, l: string) => console.log(n, l) } : {}) });
  stacks.push(s);
  return s;
}

describe('the takeover driver, on two servers in this process', () => {
  it('every takeover the compose run makes: a crash and a drain on each carrier, each server that went started again, and the whole audit verifying at the end', async () => {
    const s = await stack();
    const lines: string[] = [];
    const reports = await takeovers(s, WINDOW, { log: (l) => lines.push(l) });
    expect(reports.map((r) => `${r.going} ${r.carrier}`)).toEqual(['crash twilio', 'crash telnyx', 'drain twilio', 'drain telnyx']);
    for (const r of reports) {
      expect(r.survivor).not.toBe(r.holder);
      expect([r.holder, r.survivor].sort()).toEqual(['app-a', 'app-b']);
      expect(r.heard.endsWith("And what's your date of birth?")).toBe(true);
    }
    // A crash always hears the resumed line.
    expect(reports.filter((r) => r.going === 'crash').every((r) => r.heard.startsWith('Sorry, I lost you for a moment.'))).toBe(true);
    expect(lines.filter((l) => l.includes('] ok: taken over by'))).toHaveLength(4);
    // Both servers are up again at the end.
    for (const name of s.servers) expect(s.server(name).draining).toBe(false);
  }, 120_000);

  it('fails, naming what it found, when the call is not taken over (a server that does not hand calls on)', async () => {
    const s = await stack();
    // The survivor is gone too: the reconnect reaches no server.
    const realKill = s.kill.bind(s);
    s.kill = async (name) => {
      await realKill(name);
      await realKill(s.servers.find((n) => n !== name)!);
    };
    await expect(takeover(s, 'twilio', 'crash', WINDOW, { timeoutMs: 3000 })).rejects.toThrow(TakeoverError);
  }, 30_000);
});

describe('the driver\'s parts', () => {
  it('reads a scripted call from an app\'s fixtures, refusing one it cannot place', () => {
    const app = mkdtempSync(join(tmpdir(), 'multi-app-'));
    dirs.push(app);
    mkdirSync(join(app, 'fixtures', 'scenarios'), { recursive: true });
    writeFileSync(join(app, 'fixtures', 'scenarios', 'core.json'), JSON.stringify([
      { id: 'whole', steps: [{ say: 'one' }, { say: 'two' }, { say: 'three' }], expect: { decision: 'complete' } },
      { id: 'keys', steps: [{ say: 'one' }, { dtmf: '12' }], expect: { decision: 'complete' } },
      { id: 'silent', steps: [{ say: 'one' }, {}], expect: { decision: 'complete' } },
      { id: 'open', steps: [{ say: 'one' }, { say: 'two' }], expect: { decision: 'prompt' } },
    ]));
    expect(scriptFromScenario(app, 'whole', 2)).toEqual({ says: ['one', 'two', 'three'], goAfter: 2 });
    expect(() => scriptFromScenario(app, 'whole', 3)).toThrow(/after 1 to 2 of them/);
    expect(() => scriptFromScenario(app, 'whole', 0)).toThrow(/after 1 to 2 of them/);
    expect(() => scriptFromScenario(app, 'keys', 1)).toThrow(/not a line said/);
    expect(() => scriptFromScenario(app, 'silent', 1)).toThrow(/not a line said/);
    expect(() => scriptFromScenario(app, 'open', 1)).toThrow(/does not end the call/);
    expect(() => scriptFromScenario(app, 'none', 1)).toThrow(/no scenario none/);
  });

  it('names a lease owner\'s server, sends a start document\'s socket through the balancer, and checks turns and tool results', () => {
    expect(serverOf('app-a-0123abcd')).toBe('app-a');
    expect(serverOf('app-b')).toBe('app-b');
    const token = '0123456789abcdef0123456789abcdef';
    expect(socketUrl(`<Connect><ConversationRelay url="wss://voice.example.com/conversation/twilio?token=${token}"/></Connect>`, 'ws://127.0.0.1:18080'))
      .toBe(`ws://127.0.0.1:18080/conversation/twilio?token=${token}`);
    expect(() => socketUrl('<Response><Dial>+15555550100</Dial></Response>', 'ws://x')).toThrow(/not a start document/);
    expect(turnsAreWhole([1, 2, 3], 3)).toBe(true);
    expect(turnsAreWhole([1, 2, 2, 3], 3)).toBe(false);
    expect(turnsAreWhole([1, 3], 2)).toBe(false);
    const entry = (detail: AuditEntry['detail']): AuditEntry => ({ type: 'tool_result', detail, seq: 0, at: '', callId: 'c', channel: 'voice', prevHash: '', hash: '' });
    expect(repeatedResults([entry({ tool: 'getAccount', summary: 'account found' }), entry({ tool: 'getWindows', summary: 'window open' })])).toEqual([]);
    expect(repeatedResults([entry({ tool: 'getWindows', summary: 'window open' }), entry({ tool: 'getWindows', summary: 'window open' })])).toEqual(['{"tool":"getWindows","summary":"window open"}']);
  });
});

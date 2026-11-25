import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../converse/model/fake';
import type { ConverseModel, ModelEvent, ModelRequest } from '../converse/model/types';
import { CUT_IN_NOTE } from '../converse/turn';
import { converseFixture } from '../testing/converse/app';
import { BOOKING, CALLER, DAY, done, text, yesJev } from '../testing/converse/chat';
import type { SimTurn } from './chatDriver';
import { actionsOfCall, modelUseOfCall } from './judge';
import type { Persona } from './personas';
import { startEvalServer, type EvalServer } from './server';
import { driveVoice, SPEAKING_WORDS_PER_S } from './voiceDriver';

/**
 * The simulated callers on the voice path (eval/voiceDriver.ts): a Twilio carrier played over the relay wire to a
 * converse app's server, replies "played" at speaking pace (here at a twentieth of real time), a caller who cuts in
 * on long replies, and one whose longer turns a recognizer ends early. A fake model and scripted callers: no model.
 */

/** The tests' clock: a second of playback is 50 ms. */
const SCALE = 0.05;

const dirs: string[] = [];
const servers: EvalServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'eval-voice-'));
  dirs.push(d);
  return d;
}

const env = (dir: string): Record<string, string> => ({ PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', PORT: '0', AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub' });

async function server(model: ConverseModel): Promise<EvalServer> {
  const s = await startEvalServer(converseFixture().app, env(folder()), { work: folder(), converseModel: () => model, client: yesJev(), channel: 'voice' });
  servers.push(s);
  return s;
}

const persona = (voice?: Persona['voice']): Persona => ({ id: 'p', goal: 'Book a visit.', truth: { name: 'Sam Example' }, manner: 'Plain.', expects: 'booking', callingFrom: CALLER, ...(voice !== undefined ? { voice } : {}) });

/** A caller saying `lines` in turn, then hanging up; each call's view of the turns kept. */
function scripted(lines: string[]): { caller: (p: Persona, turns: readonly SimTurn[]) => Promise<string | null>; seen: SimTurn[][]; askedAt: number[] } {
  const seen: SimTurn[][] = [];
  const askedAt: number[] = [];
  let i = 0;
  return {
    seen,
    askedAt,
    caller: async (_p, turns) => {
      seen.push(turns.map((t) => ({ ...t })));
      askedAt.push(Date.now());
      return lines[i++] ?? null;
    },
  };
}

const words = (t: string): string[] => t.trim().split(/\s+/);

describe('driveVoice', () => {
  it('a voice call books a visit and is recorded like a chat call', async () => {
    const s = await server(fakeModel(BOOKING));
    const c = scripted([`Is there a visit free on ${DAY}?`, 'The morning please, for Sam Example, on this number.', 'yes']);
    const began = Date.now();
    const call = await driveVoice({ url: s.ws, serverHttp: s.http, persona: persona(), caller: c.caller, maxTurns: 6, timeoutMs: 5000, turnEnds: s.turnEnds, timeScale: SCALE });
    expect(call.channel).toBe('voice');
    expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line', 'caller', 'line', 'caller', 'line']);
    expect(call.turns[0]!.text).toBe('Example Visits, how can I help?');
    expect(call.turns[2]!.text).toBe('Let me look. We have the morning, 9 to 12, or the afternoon. Which would suit you?');
    expect(call.turns[4]!.text).toMatch(/^A visit Tuesday, January 15, 9 to 12 for Sam Example/);
    expect(call.turns[6]!.text).toBe('You are booked for Tuesday morning.');
    expect(call.ended).toBe('caller');
    expect(call.callerEnded).toEqual({ how: 'hang_up' });
    expect([call.cutIns, call.fragments]).toEqual([0, 0]);
    expect(call.firstWordMs).toHaveLength(3);
    expect(call.firstWordMs.every((m) => m >= 0 && m < 5000)).toBe(true);
    // Each reply was played before the caller answered it: its words at speaking pace, from its first frame.
    for (const [i, at] of c.askedAt.entries()) {
      const line = call.turns[i * 2]!;
      expect(at - began - line.atMs).toBeGreaterThanOrEqual((words(line.text).length / SPEAKING_WORDS_PER_S) * 1000 * SCALE - 5);
    }
    // Recorded as a chat call is: its id is the call's in the audit and the traces, which the run reads the same way.
    expect(call.callId).toMatch(/^CA[0-9a-f]{32}$/);
    await s.close();
    servers.splice(0);
    expect(actionsOfCall(s.auditDir, call.callId!).filter((a) => a.verdict === 'ALLOW').map((a) => a.tool)).toContain('book');
    expect(modelUseOfCall(s.traceDir, call.callId!).turns.length).toBeGreaterThan(0);
  }, 20_000);

  it('an interrupting caller cuts in and is shown only what played', async () => {
    const long = 'We have plenty of room this week. ' + 'The morning runs from nine to twelve and the afternoon from one to five, and either one can take a visit to look at a single item in your home. Which day would suit you best?';
    const n = words(long).length;
    expect(n).toBeGreaterThan(30);
    const model = fakeModel([[text(long), done()], [text('Tuesday works.'), done()]]);
    const s = await server(model);
    const c = scripted(['Tell me about your visits.', 'Tuesday please.']);
    const call = await driveVoice({ url: s.ws, serverHttp: s.http, persona: persona({ interrupts: true, fragments: false }), caller: c.caller, maxTurns: 6, timeoutMs: 5000, turnEnds: s.turnEnds, timeScale: SCALE });
    expect(call.cutIns).toBe(1);
    const played = words(long).slice(0, Math.ceil(n * 0.4)).join(' ');
    // The caller was shown the words played, and nothing after them.
    expect(c.seen[1]!.at(-1)).toMatchObject({ who: 'line', text: played });
    expect(call.turns[2]).toMatchObject({ who: 'line', text: played });
    expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line', 'caller', 'line']);
    expect(call.turns[4]!.text).toBe('Tuesday works.');
    // The line was told the caller cut in where the words played ended (the interrupt's utteranceUntilInterrupt).
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(`${played}${CUT_IN_NOTE}`);
  }, 20_000);

  it('a fragmenting caller\'s long turn arrives in two parts', async () => {
    const requests: ModelRequest[] = [];
    const script = fakeModel([[text('Sure, Tuesday morning works.'), done()]]);
    let n = 0;
    // The first request is still streaming (nothing played) when the turn's second part arrives.
    const model: ConverseModel = {
      id: 'fake',
      stream(req, signal) {
        requests.push(structuredClone(req));
        if (n++ > 0) return script.stream(req, signal);
        return (async function* (): AsyncIterable<ModelEvent> {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        })();
      },
    };
    const s = await server(model);
    const said = 'I would like a visit on Tuesday morning to look at a lamp';
    const c = scripted([said]);
    const call = await driveVoice({ url: s.ws, serverHttp: s.http, persona: persona({ interrupts: false, fragments: true }), caller: c.caller, maxTurns: 6, timeoutMs: 5000, turnEnds: s.turnEnds, timeScale: SCALE });
    expect(call.fragments).toBe(1);
    expect(call.turns.map((t) => [t.who, t.text])).toEqual([['line', 'Example Visits, how can I help?'], ['caller', said], ['line', 'Sure, Tuesday morning works.']]);
    const all = words(said);
    const first = all.slice(0, Math.floor(all.length / 2)).join(' ');
    const second = all.slice(Math.floor(all.length / 2)).join(' ');
    expect(requests).toHaveLength(2);
    const last = JSON.stringify([...requests[1]!.messages].reverse().find((m) => m.role === 'user'));
    expect(last).toContain(first);
    expect(last).toContain(second);
    expect(call.firstWordMs).toHaveLength(1);
  }, 20_000);
});

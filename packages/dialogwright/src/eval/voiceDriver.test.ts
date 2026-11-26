import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { fakeModel } from '../converse/model/fake';
import type { ConverseModel, ModelEvent, ModelRequest } from '../converse/model/types';
import { BRIDGE_AFTER_MS, CUT_IN_NOTE } from '../converse/turn';
import { converseFixture } from '../testing/converse/app';
import { BOOKING, CALLER, DAY, done, text, yesJev } from '../testing/converse/chat';
import type { SimTurn, TurnEnds } from './chatDriver';
import { actionsOfCall, modelUseOfCall } from './judge';
import type { Persona } from './personas';
import { startEvalServer, type EvalServer } from './server';
import { driveVoice, SPEAKING_WORDS_PER_S } from './voiceDriver';

/**
 * The simulated callers on the voice path (eval/voiceDriver.ts): a Twilio carrier played over the relay wire to a
 * agent app's server, replies "played" at speaking pace (here at a twentieth of real time), a caller who cuts in
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
    // No reply waited for the bridge: the first frame heard is the reply's.
    expect(call.replyFirstMs).toEqual(call.firstWordMs);
    expect(call.bridged).toBe(0);
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
    expect(call.turns[2]).toMatchObject({ who: 'line', text: played, cut: true, unheard: words(long).slice(Math.ceil(n * 0.4)).join(' ') });
    // The caller was never shown the words they did not hear, nor the mark.
    expect(c.seen[1]!.at(-1)).not.toHaveProperty('unheard');
    expect(call.turns[4]).not.toHaveProperty('cut');
    expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line', 'caller', 'line']);
    expect(call.turns[4]!.text).toBe('Tuesday works.');
    // The line was told the caller cut in where the words played ended (the interrupt's utteranceUntilInterrupt).
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(`${played}${CUT_IN_NOTE}`);
  }, 20_000);

  it('a model slow enough for the bridge: the first frame heard is the bridge\'s, the reply\'s first frame the model\'s', async () => {
    const script = fakeModel([[text('Tuesday morning is free.'), done()]]);
    // The model's first words come well after BRIDGE_AFTER_MS, so the line says the bridge first.
    const model: ConverseModel = {
      id: 'fake',
      stream(req, signal) {
        return (async function* (): AsyncIterable<ModelEvent> {
          await new Promise((resolve) => setTimeout(resolve, BRIDGE_AFTER_MS + 500));
          yield* script.stream(req, signal);
        })();
      },
    };
    const s = await server(model);
    const c = scripted(['Anything free on Tuesday?']);
    const call = await driveVoice({ url: s.ws, serverHttp: s.http, persona: persona(), caller: c.caller, maxTurns: 6, timeoutMs: 5000, turnEnds: s.turnEnds, timeScale: SCALE });
    expect(call.turns[2]).toMatchObject({ who: 'line', text: 'One sec. Tuesday morning is free.' });
    expect(call.bridged).toBe(1);
    expect(call.firstWordMs).toHaveLength(1);
    expect(call.replyFirstMs).toHaveLength(1);
    expect(call.firstWordMs[0]).toBeGreaterThanOrEqual(BRIDGE_AFTER_MS - 100);
    expect(call.firstWordMs[0]).toBeLessThan(BRIDGE_AFTER_MS + 450);
    expect(call.replyFirstMs![0]).toBeGreaterThanOrEqual(BRIDGE_AFTER_MS + 450);
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

/**
 * A carrier's far end of its own, in place of the eval server: it answers the call, takes the relay's socket and says
 * the replies a test gives it, one per turn (the greeting first), each a text frame with its `interruptible`, then tells
 * the turn's end; it keeps every message the driver sent, with when it came.
 */
async function farEnd(replies: { token: string; interruptible: boolean }[]): Promise<{ http: string; ws: string; turnEnds: TurnEnds; got: { msg: Record<string, unknown>; at: number }[]; sentAt: number[]; close: () => Promise<void> }> {
  const got: { msg: Record<string, unknown>; at: number }[] = [];
  const sentAt: number[] = [];
  const watchers = new Map<string, () => void>();
  const ended = new Map<string, number>();
  const server = createServer((req, res) => {
    const host = req.headers.host ?? '';
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(req.url === '/voice/twilio' ? `<Response><Connect><ConversationRelay url="ws://${host}/relay?t=1"/></Connect></Response>` : '');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    let callSid = '';
    let turn = 0;
    const say = (): void => {
      const r = replies[turn++];
      if (r === undefined) return;
      sentAt.push(Date.now());
      socket.send(JSON.stringify({ type: 'text', token: r.token, last: true, lang: 'en-US', interruptible: r.interruptible, preemptible: false }));
      ended.set(callSid, (ended.get(callSid) ?? 0) + 1);
      watchers.get(callSid)?.();
    };
    socket.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as Record<string, unknown>;
      got.push({ msg, at: Date.now() });
      if (msg.type === 'setup') {
        callSid = String(msg.callSid);
        say();
      } else if (msg.type === 'prompt' && msg.last === true) say();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const turnEnds: TurnEnds = {
    watch(id, fn) {
      watchers.set(id, fn);
      for (let i = 0; i < (ended.get(id) ?? 0); i++) fn();
      return () => void watchers.delete(id);
    },
  };
  return {
    http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, turnEnds, got, sentAt,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}

/** Every trace record the server wrote, from its trace folder. */
function tracesOf(s: EvalServer): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const at = join(dir, name);
      if (statSync(at).isDirectory()) walk(at);
      else if (name.endsWith('.jsonl') && !name.endsWith('.frames.jsonl')) for (const line of readFileSync(at, 'utf8').split('\n')) if (line.trim() !== '') out.push(JSON.parse(line) as Record<string, unknown>);
    }
  };
  walk(s.traceDir);
  return out;
}

describe('driveVoice: silence', () => {
  it('a persona that stays silent once (voice.silentOnce) hears the line answer the silence, then goes on', async () => {
    const { app } = converseFixture();
    const quick = { ...app, business: { ...app.business, silence: { afterMs: 3000, reprompts: 1 } } };
    const work = folder();
    const s = await startEvalServer(quick, env(folder()), { work, converseModel: () => fakeModel([[text('We have mornings and afternoons. Which day?'), done()], [text('Take your time.'), done()], [text('Tuesday works.'), done()]]), client: yesJev(), channel: 'voice' });
    servers.push(s);
    const c = scripted(['Hi, I need a visit.', 'Tuesday please.']);
    const call = await driveVoice({ url: s.ws, serverHttp: s.http, persona: persona({ interrupts: false, fragments: false, silentOnce: true }), caller: c.caller, maxTurns: 6, timeoutMs: 15_000, turnEnds: s.turnEnds, timeScale: SCALE });
    expect(call.turns.map((t) => [t.who, t.text, t.silent ?? false])).toEqual([
      ['line', 'Example Visits, how can I help?', false],
      ['caller', 'Hi, I need a visit.', false],
      ['line', 'We have mornings and afternoons. Which day?', false],
      ['caller', '(says nothing)', true],
      ['line', 'Take your time.', false],
      ['caller', 'Tuesday please.', false],
      ['line', 'Tuesday works.', false],
    ]);
    expect(tracesOf(s).filter((r) => r.silence !== undefined).map((r) => r.silence)).toEqual([1]);
  }, 30_000);
});

describe('driveVoice: a line the caller cannot interrupt', () => {
  const HELD = 'So that is a visit on Tuesday, January fifteenth, in the morning window from nine to twelve, for Sam Example, and we will reach you on the number you are calling from, ending in zero one two three, with a text the day before. Is that right?';

  it('an interrupting caller plays it to its end, never cuts in, and answers after it with a partial then their words', async () => {
    expect(words(HELD).length).toBeGreaterThan(30);
    const far = await farEnd([{ token: 'Example Visits, how can I help?', interruptible: true }, { token: HELD, interruptible: false }, { token: 'You are booked.', interruptible: true }]);
    try {
      const c = scripted(['A visit Tuesday morning, please.', 'yes']);
      const call = await driveVoice({ url: far.ws, serverHttp: far.http, persona: persona({ interrupts: true, fragments: false }), caller: c.caller, maxTurns: 6, timeoutMs: 5000, turnEnds: far.turnEnds, timeScale: SCALE });
      expect(call.cutIns).toBe(0);
      expect(far.got.map((g) => g.msg.type)).not.toContain('interrupt');
      // Heard whole, with no cut mark, and answered: the persona's next turn reached the line.
      expect(call.turns.map((t) => t.who)).toEqual(['line', 'caller', 'line', 'caller', 'line']);
      expect(call.turns[2]).toEqual(expect.objectContaining({ who: 'line', text: HELD }));
      expect(call.turns[2]).not.toHaveProperty('cut');
      expect(c.seen[1]!.at(-1)).toMatchObject({ who: 'line', text: HELD });
      expect(call.turns[4]!.text).toBe('You are booked.');
      // The answer went after the line had played: a partial first, as Twilio sends with partial prompts on, then the words.
      const prompts = far.got.filter((g) => g.msg.type === 'prompt');
      expect(prompts.map((g) => [g.msg.voicePrompt, g.msg.last])).toEqual([['A', false], ['A visit Tuesday morning, please.', true], ['yes', false], ['yes', true]]);
      const playedMs = words(HELD).length * (1000 / SPEAKING_WORDS_PER_S) * SCALE;
      expect(prompts[2]!.at - far.sentAt[1]!).toBeGreaterThanOrEqual(playedMs - 5);
      // A held line is the reply's own: neither the bridge nor a reply never begun.
      expect(call.bridged).toBe(0);
      expect(call.replyFirstMs![0]).toBeLessThan(1000);
    } finally {
      await far.close();
    }
  }, 20_000);
});

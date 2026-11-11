import { describe, expect, it } from 'vitest';
import type { AuditSink } from '../../audit/sink';
import type { AuditDraft } from '../../audit/types';
import type { ServerMessage } from '../../channel/chat/protocol';
import { fakeModel } from '../../converse/model/fake';
import type { ModelEvent } from '../../converse/model/types';
import { newConverseState, type ConverseState } from '../../converse/state';
import type { AnswerMap, JevClient } from '../../jev/types';
import { converseFixture } from '../../testing/converse/app';
import { BOOKING, CALLER, DAY, done, text } from '../../testing/converse/chat';
import type { StoredChat } from '../stores/types';
import { CONVERSE_SCHEMA, converseChatRuntime, stateOf } from './converseRuntime';
import type { ChatIo } from './runtime';

/** A converse chat's end with no turn of its own: a chat saved before a restart and never resumed; and a chat's words on the wire, turn by turn. */

function runtime() {
  const rows: { callId: string; row: AuditDraft }[] = [];
  const audit: AuditSink = {
    append(callId, channel, row) {
      rows.push({ callId, row });
      return { ...row, seq: rows.length, at: '2026-11-11T15:00:00.000Z', callId, channel, prevHash: '', hash: '' };
    },
  };
  const jev: JevClient = { ask: async () => { throw new Error('not asked'); } };
  const { app } = converseFixture();
  const rt = converseChatRuntime({
    app, model: fakeModel([]), jev, jevTimeoutMs: 1000, audit, texts: null, now: () => 0, log: () => {},
    resources: () => { throw new Error('no resources'); },
  });
  return { rt, rows };
}

const saved = (state: ConverseState): StoredChat => ({ id: state.callId, schema: CONVERSE_SCHEMA, session: state, resumeHash: 'h', createdAtMs: 0, lastActivityMs: 0, auditTail: [] });

describe('converseChatRuntime: a saved state', () => {
  it('loads a state saved before the carried note was kept (no note waits), keeps one that was, and drops one that is not text', () => {
    const before = JSON.parse(JSON.stringify(newConverseState({ appId: 'visits', callId: 'chat-3', channel: 'chat' }))) as unknown;
    expect(stateOf(before)).not.toBeNull();
    expect(stateOf(before)!.carriedNote).toBeUndefined();
    const carried = { ...newConverseState({ appId: 'visits', callId: 'chat-4', channel: 'chat' }), carriedNote: '[a note]' };
    expect(stateOf(JSON.parse(JSON.stringify(carried)))!.carriedNote).toBe('[a note]');
    const odd = { ...newConverseState({ appId: 'visits', callId: 'chat-5', channel: 'chat' }), carriedNote: 7 };
    expect(stateOf(odd)!.carriedNote).toBeUndefined();
  });
});

describe('converseChatRuntime: a chat abandoned', () => {
  it('with a read-back waiting for its answer records that it was dropped, as a caller leaving does, then the end', () => {
    const { rt, rows } = runtime();
    const state = { ...newConverseState({ appId: 'visits', callId: 'chat-1', channel: 'chat' }), pending: { action: 'book', params: { window: 'w-1' }, hash: 'x', text: 'A visit. Is that right?', id: 'c1' } };
    rt.abandoned(saved(state));
    expect(rows).toEqual([
      { callId: 'chat-1', row: { type: 'converse_left', detail: { pending: 'book' } } },
      { callId: 'chat-1', row: { type: 'call_ended', detail: { reason: 'abandoned' } } },
    ]);
  });

  it('with nothing waiting records the end alone', () => {
    const { rt, rows } = runtime();
    rt.abandoned(saved(newConverseState({ appId: 'visits', callId: 'chat-2', channel: 'chat' })));
    expect(rows.map((r) => r.row.type)).toEqual(['call_ended']);
  });
});

/** A chat's transport as the runtime sees it: what is sent, in order, and the frame log's lines as written. */
function fakeIo(id: string) {
  const sent: ServerMessage[] = [];
  const frames: { dir: string; msg: unknown }[] = [];
  const io: ChatIo = {
    id, frames: { write: (dir, msg) => void frames.push({ dir, msg }) }, restores: 0, movedAway: false, ended: false, lastActivityMs: 0,
    send(m, scrub) {
      sent.push(m);
      frames.push({ dir: 'out', msg: m.type === 'say' && scrub ? { ...m, text: scrub(m.text) } : m });
    },
    sendLogLater(m) {
      sent.push(m);
      return (scrub) => void frames.push({ dir: 'out', msg: m.type === 'say' && scrub ? { ...m, text: scrub(m.text) } : m });
    },
    ready: (locale) => ({ type: 'ready', session: id, resume: 'r', locale }),
    record: (dir, msg) => void frames.push({ dir, msg }),
    connected: () => true,
    save() {},
    finish() {},
  };
  return { io, sent, frames, says: () => sent.flatMap((m) => (m.type === 'say' ? [m.text] : [])) };
}

const SLIP = 'We are open Saturdays too.';
const CORRECTION = 'Sorry, I should correct that: we are open every day, 9 to 5.';

/**
 * A decision model that reads every reply as `claims`, `lateMs` after it is asked, keeping how many `say`s had
 * been sent when it was asked (`saysWhenAsked`); and a read-back's answer as a yes.
 */
function claimsJev(claims: { contradicted: number; notDone: number; gap: number }, says: () => string[], lateMs = 0): JevClient & { saysWhenAsked: number[] } {
  const saysWhenAsked: number[] = [];
  return {
    saysWhenAsked,
    async ask(req) {
      const reading = Object.hasOwn(req.questions, 'contradicted');
      if (reading) {
        saysWhenAsked.push(says().length);
        await new Promise((r) => setTimeout(r, lateMs));
      }
      const answers: AnswerMap = reading
        ? { contradicted: { type: 'noul', noul: claims.contradicted }, notDone: { type: 'noul', noul: claims.notDone }, gap: { type: 'noul', noul: claims.gap } }
        : { confirmsYes: { type: 'noul', noul: 0.95 }, confirmsNo: { type: 'noul', noul: 0.05 } };
      return { answers, model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev' };
    },
  };
}

/** A chat on the fixture app, opened (the greeting said), with the model's side `turns` and a decision model reading replies as `claims`. */
async function chat(turns: ModelEvent[][], claims: { contradicted: number; notDone: number; gap: number }, lateMs = 0, extra: { onClaimsRead?: Parameters<typeof converseChatRuntime>[0]['onClaimsRead']; log?: (l: string) => void } = {}) {
  const t = fakeIo('chat-9');
  const jev = claimsJev(claims, t.says, lateMs);
  const { app } = converseFixture(() => new Date('2030-01-14T15:00:00Z'));
  const traced: unknown[] = [];
  /** Each turn's end (onTurnEnd): the chat's id and the messages sent by then. */
  const ends: { id: string; sent: ServerMessage[] }[] = [];
  const rt = converseChatRuntime({
    app, model: fakeModel(turns), jev, jevTimeoutMs: 2000, onTurnEnd: (id) => void ends.push({ id, sent: [...t.sent] }), audit: { append: (callId, channel, row) => ({ ...row, seq: 1, at: '2030-01-14T15:00:00.000Z', callId, channel, prevHash: '', hash: '' }) },
    texts: null, now: () => Date.parse('2030-01-14T15:00:00Z'), log: extra.log ?? (() => {}),
    ...(extra.onClaimsRead !== undefined ? { onClaimsRead: extra.onClaimsRead } : {}),
    resources: () => ({ trace: { write: (r) => void traced.push(r) }, frames: t.io.frames }),
  });
  rt.prepare('chat-9');
  rt.create('chat-9', t.io);
  await rt.open('chat-9', { context: { callerNumber: CALLER }, stream: false }, t.io);
  return { ...t, rt, jev, ends };
}

describe('converseChatRuntime: a reply on the wire', () => {
  const WRONG = { contradicted: 0.9, notDone: 0.1, gap: 0.1 };
  const FINE = { contradicted: 0.1, notDone: 0.1, gap: 0.1 };

  it('sends a reply\'s say at once, before the check after speaking has answered, and its correction as a second say', async () => {
    const c = await chat([[text(SLIP), done()], [text(CORRECTION), done()]], WRONG, 150);
    expect(c.says()).toEqual(['Example Visits, how can I help?']);
    const started = Date.now();
    let firstAt: number | null = null;
    const sent = c.sent.length;
    const watch = setInterval(() => {
      if (firstAt === null && c.sent.slice(sent).some((m) => m.type === 'say')) firstAt = Date.now() - started;
    }, 5);
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    clearInterval(watch);
    expect(c.says().slice(1)).toEqual([SLIP, CORRECTION]);
    // The reply was on the wire when the decision model was asked, and well before its late answer.
    expect(c.jev.saysWhenAsked).toEqual([2]);
    expect(firstAt).not.toBeNull();
    expect(firstAt!).toBeLessThan(100);
  });

  it('catches a throwing onClaimsRead hook: logged, and the turn goes on to its correction', async () => {
    const logged: string[] = [];
    const c = await chat([[text(SLIP), done()], [text(CORRECTION), done()]], WRONG, 0, { onClaimsRead: () => { throw new Error('hook broke'); }, log: (l) => void logged.push(l) });
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    expect(c.says().slice(1)).toEqual([SLIP, CORRECTION]);
    expect(logged.join('\n')).toMatch(/chat chat-9: the check's input hook failed: Error: hook broke/);
  });

  it('sends one say for a reply the check reads as fine', async () => {
    const c = await chat([[text(SLIP), done()]], FINE);
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    expect(c.says().slice(1)).toEqual([SLIP]);
    expect(c.sent.filter((m) => m.type === 'say')).toHaveLength(2);
  });

  it('sends what a failing correction said of itself as a last say at the turn\'s end, and nothing more', async () => {
    const c = await chat([[text(SLIP), done()], [text('Sorry, I misspoke. We are'), { type: 'error', kind: 'timeout', detail: 'late' }]], WRONG);
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    expect(c.says().slice(1)).toEqual([SLIP, 'Sorry, I misspoke.']);
    expect(c.sent.some((m) => m.type === 'end')).toBe(false);
  });

  it('keeps each say in the frame log as the trace keeps the line: each value the records mask, masked', async () => {
    const c = await chat([BOOKING[0]!, BOOKING[1]!, BOOKING[2]!], FINE);
    await c.rt.text('chat-9', `Is there a visit free on ${DAY}?`, c.io);
    await c.rt.text('chat-9', 'The morning please, for Sam Example, on this number.', c.io);
    expect(c.says().at(-1)).toContain('Sam Example');
    const logged = c.frames.filter((f) => f.dir === 'out' && (f.msg as ServerMessage).type === 'say').map((f) => (f.msg as { text: string }).text);
    expect(logged.at(-1)).toBe('A visit • for <11 chars>, on ...0123. Is that right?');
    expect(JSON.stringify(c.frames)).not.toContain('Sam Example');
  });
});

describe('converseChatRuntime: the turn\'s end (onTurnEnd)', () => {
  const WRONG = { contradicted: 0.9, notDone: 0.1, gap: 0.1 };
  const FINE = { contradicted: 0.1, notDone: 0.1, gap: 0.1 };
  const saysOf = (sent: ServerMessage[]): string[] => sent.flatMap((m) => (m.type === 'say' ? [m.text] : []));

  it('is called once the opening has said its greeting, with the chat\'s id', async () => {
    const c = await chat([], FINE);
    expect(c.ends.map((e) => e.id)).toEqual(['chat-9']);
    expect(saysOf(c.ends[0]!.sent)).toEqual(['Example Visits, how can I help?']);
  });

  it('is called once a turn\'s reply is sent, and once only', async () => {
    const c = await chat([[text(SLIP), done()]], FINE);
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    expect(c.ends).toHaveLength(2);
    expect(saysOf(c.ends[1]!.sent).slice(1)).toEqual([SLIP]);
  });

  it('for a corrected turn, is called after the correction\'s say, and once only', async () => {
    const c = await chat([[text(SLIP), done()], [text(CORRECTION), done()]], WRONG, 150);
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io);
    expect(c.ends).toHaveLength(2);
    expect(saysOf(c.ends[1]!.sent).slice(1)).toEqual([SLIP, CORRECTION]);
    expect(c.ends[1]!.sent).toEqual(c.sent);
  });

  it('is called for a turn whose model failed, once its recovery is sent', async () => {
    const c = await chat([[{ type: 'error', kind: 'timeout', detail: 'late' }]], FINE);
    const before = c.ends.length;
    await c.rt.text('chat-9', 'Are you open Saturday?', c.io).catch(() => undefined);
    expect(c.ends).toHaveLength(before + 1);
  });
});

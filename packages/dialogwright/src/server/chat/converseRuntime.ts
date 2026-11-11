import type { AuditSink } from '../../audit/sink';
import type { ServerMessage } from '../../channel/chat/protocol';
import type { ConverseApp } from '../../converse/app';
import type { ConverseModel } from '../../converse/model/types';
import { policyOf } from '../../converse/policy';
import { accountOf } from '../../converse/sources/accounts';
import { converseTexts } from '../../converse/sources/texts';
import { newConverseState, type ConverseState } from '../../converse/state';
import { converseTurn, type ConverseDeps, type Input, type Out } from '../../converse/turn';
import { E164 } from '../../core/numberLocales';
import type { JevClient } from '../../jev/types';
import { textAuditRow } from '../../texts/record';
import type { TurnTexts } from '../../texts/types';
import type { TraceSink } from '../../trace/writer';
import type { FrameSink } from '../frameLog';
import { CHAT_TURN_ERROR, type ChatIo, type ChatRuntime } from './runtime';

/**
 * The web chat of a converse app (src/converse, docs/designs/2026-11-11-agent-runtime.md): each chat a
 * ConverseState, each turn converseTurn, its words sent on the chat wire, its trace records the converse
 * runtime's (kind 'converse'), its audit the app's chain. The transport (chat/socket.ts) holds the socket,
 * the resume token and the saves; this holds each chat's state.
 *
 * - A reply goes to the client as a `say` as soon as its last piece is said (the model's sentences and any
 *   fixed line, joined), before the check after speaking reads it; a correction the check asks for follows
 *   as a second `say`. A client whose start says `stream: true` is also sent each sentence as `say_delta` as
 *   soon as it is ready, before its `say`. The frame log keeps each `say` as the trace keeps the line (each
 *   value the records mask, masked): its line is written at the turn's end, with the turn's own masking,
 *   since a value said in a reply may be one a call later in the turn records masked.
 * - The call's end: the closing line (the model's end_call), then `end`; a handoff (the model failed past
 *   the business's budget), the handoff line, then `transfer` where agent.yaml names a transfer number,
 *   and `end`. Each end is recorded in the audit as `call_ended`, as a scripted chat's is.
 * - A chat has no calling number. Where app.yaml says `chat.callerNumberFromContext: true`, the start's
 *   context `callerNumber` (E.164) is taken as the number the chat calls from: the account it is
 *   recognised as, and the "caller" token of a phone param.
 * - The state is saved after every turn under the schema 'converse-1', so a restart resumes the chat
 *   where it was (a read-back waiting for its answer included); a reply still streaming is not resumed.
 *   A resume streams where the resuming client's start says `stream: true`, whatever the first said.
 * - No sign-in: a token on a start or a sign_in is refused, as on a chat whose sign-in is off.
 * - Once a turn (the start, a text) has sent all it says, its correction included, `onTurnEnd` is told, where
 *   the server was given one (the simulated callers' server, eval/server.ts).
 */

/** The schema a converse chat is saved under (StoredChat.schema). */
export const CONVERSE_SCHEMA = 'converse-1';
/** The language a converse chat speaks (agent.yaml's lines are English for now). */
const LANG = 'en';
/** What a chat that names a token is told: a converse app takes no sign-in. */
const NO_SIGN_IN: ServerMessage = { type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' };

export interface ConverseChatDeps {
  app: ConverseApp;
  /** The model that holds the conversation: agent.yaml's `model.default`, resolved with the app's settings (a test's fake). */
  model: ConverseModel;
  /** The decision model, which reads the caller's answer to a read-back. */
  jev: JevClient;
  jevTimeoutMs: number;
  /** The app's audit chain. */
  audit: AuditSink;
  /** The app's text sender (TEXT_FROM), or null. */
  texts: TurnTexts | null;
  /** The app's settings by name, as its actions' code reads them (ctx.env): on a host its own file over the server's. */
  env?: (name: string) => string | undefined;
  now: () => number;
  log: (line: string) => void;
  /** A chat's trace and frame log, by its id. */
  resources(id: string): { trace: TraceSink; frames: FrameSink };
  /**
   * Called once a turn of the person (the start, a text) has finished, with everything it says sent (the reply,
   * and the correction when there is one): the simulated callers' driver ends a reply on it (eval/chatDriver.ts),
   * the chat wire having no end-of-turn message. Absent on a deployment.
   */
  onTurnEnd?: (chatId: string) => void;
  /**
   * Called with what the check after speaking was sent for a reply and what it read (ConverseDeps.onClaimsRead):
   * the evaluation keeps each reply's input with it (eval --claims-cases). Absent on a deployment.
   */
  onClaimsRead?: ConverseDeps['onClaimsRead'];
}

/** One chat as this runtime holds it. */
interface ConverseChat {
  state: ConverseState;
  trace: TraceSink;
  /** The client takes say_delta: what the start of the client now on the chat said (its open, or its resume). */
  stream: boolean;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A reply's pieces as one line of text: each trimmed, joined by a space. */
const joined = (pieces: readonly string[]): string => pieces.map((p) => p.trim()).filter((p) => p !== '').join(' ');

/**
 * A saved converse state as it was written (newConverseState's shape), or null. A state saved before a field
 * was kept loads as it is: a carried note absent is none (and one that is not text is dropped).
 */
export function stateOf(session: unknown): ConverseState | null {
  const s = session as Partial<ConverseState> | null;
  if (typeof s !== 'object' || s === null || s.kind !== 'converse' || s.v !== 1 || typeof s.appId !== 'string' || !Array.isArray(s.messages)) return null;
  if (s.carriedNote !== undefined && typeof s.carriedNote !== 'string') delete s.carriedNote;
  return s as ConverseState;
}

export function converseChatRuntime(deps: ConverseChatDeps): ChatRuntime {
  const { app, log } = deps;
  const policy = policyOf(app.business);
  const chats = new Map<string, ConverseChat>();
  /** Each chat's trace, made with its frame log (prepare) and taken when the chat is held. */
  const prepared = new Map<string, TraceSink>();
  const take = (id: string): TraceSink => {
    const trace = prepared.get(id);
    if (trace === undefined) throw new Error(`chat ${id}: no resources prepared`);
    prepared.delete(id);
    return trace;
  };
  const held = (id: string): ConverseChat => {
    const c = chats.get(id);
    if (c === undefined) throw new Error(`chat ${id}: not held by this runtime`);
    return c;
  };
  const audited = (id: string, reason: string): void => {
    try {
      const r = deps.audit.append(id, 'chat', { type: 'call_ended', detail: { reason } });
      if (r instanceof Promise) r.catch((err: unknown) => log(`chat ${id}: the end's audit entry failed: ${describeError(err)}`));
    } catch (err) {
      log(`chat ${id}: the end's audit entry failed: ${describeError(err)}`);
    }
  };

  /** The turn's end told (deps.onTurnEnd); a hook that throws is logged, never the chat's failure. */
  const turnEnded = (id: string): void => {
    if (deps.onTurnEnd === undefined) return;
    try {
      deps.onTurnEnd(id);
    } catch (err) {
      log(`chat ${id}: the turn's end hook failed: ${describeError(err)}`);
    }
  };

  /** The check's input told (deps.onClaimsRead); a hook that throws is logged, never the chat's failure. */
  const claimsRead: ConverseDeps['onClaimsRead'] = deps.onClaimsRead === undefined ? undefined : (callId, read) => {
    try {
      deps.onClaimsRead!(callId, read);
    } catch (err) {
      log(`chat ${callId}: the check's input hook failed: ${describeError(err)}`);
    }
  };

  /** A turn's dependencies: the app's, its texts recorded in the chat's audit, each trace record written to the chat's trace. */
  const turnDeps = (id: string, c: ConverseChat): ConverseDeps => ({
    business: app.business,
    ...(claimsRead !== undefined ? { onClaimsRead: claimsRead } : {}),
    model: deps.model,
    jev: deps.jev,
    policy,
    audit: deps.audit,
    tools: app.tools,
    texts: converseTexts(deps.texts, (r) => {
      const chained = deps.audit.append(id, 'chat', textAuditRow(r));
      if (chained instanceof Promise) chained.catch((err: unknown) => log(`chat ${id}: a text's audit entry failed: ${describeError(err)}`));
    }),
    now: () => new Date(deps.now()),
    trace: (r) => c.trace.write(r),
    jevTimeoutMs: deps.jevTimeoutMs,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
  });

  /** One turn: its words sent, the chat ended where the turn ended it, else saved. Whether it ended. */
  const run = async (id: string, c: ConverseChat, input: Input, io: ChatIo): Promise<boolean> => {
    let pieces: string[] = [];
    /** Each `say` sent this turn, with the call that writes its frame log line. */
    const sent: { text: string; log: (scrub: ((text: string) => string) | null) => void }[] = [];
    let scrub: ((text: string) => string) | null = null;
    /** The pieces said since the last `say`, sent as one. */
    const flush = (): void => {
      const text = joined(pieces);
      pieces = [];
      if (text !== '') sent.push({ text, log: io.sendLogLater({ type: 'say', text, lang: LANG }) });
    };
    const out: Out = {
      say(text, final) {
        pieces.push(text);
        if (c.stream) io.send({ type: 'say_delta', text });
        if (final) flush();
      },
      // The end is read from the state the turn returns (ConverseState.ended).
      end() {},
      scrubbed(s) {
        scrub = s;
      },
    };
    io.lastActivityMs = deps.now();
    try {
      c.state = await converseTurn(c.state, input, turnDeps(id, c), out);
    } catch (err) {
      log(`chat ${id}: turn failed: ${describeError(err)}`);
      // What was sent before the failure is kept in the frame log by its length alone, never whole.
      for (const s of sent) s.log(() => `<${s.text.length} chars>`);
      io.send({ type: 'error', code: 'server_error', message: CHAT_TURN_ERROR });
      io.record('log', { turnFailed: describeError(err) });
      return false;
    }
    // Pieces with no final piece after them (a correction that failed after saying part of itself) go as a last `say`.
    flush();
    // The frame log keeps each line as the trace does: each value the records mask, masked. A turn that gave
    // no masking (none is expected) keeps each line by its length alone, never whole.
    const masked = scrub as ((text: string) => string) | null;
    for (const s of sent) s.log(masked ?? (() => `<${s.text.length} chars>`));
    const ended = c.state.ended;
    if (ended === 'closing' || ended === 'handoff') {
      if (ended === 'handoff' && app.business.transfer !== undefined) io.send({ type: 'transfer', reason: 'handoff' });
      io.send({ type: 'end' });
      audited(id, ended === 'closing' ? 'completed' : 'handoff');
      io.finish(ended);
      return true;
    }
    io.save();
    return false;
  };

  return {
    prepare(id) {
      const { trace, frames } = deps.resources(id);
      prepared.set(id, trace);
      return frames;
    },

    create(id) {
      chats.set(id, { state: newConverseState({ appId: app.id, callId: id, channel: 'chat' }), trace: take(id), stream: false });
    },

    async open(id, start, io) {
      const c = held(id);
      c.stream = start.stream;
      // A chat calls from no number, unless the app takes one from its context (tests, the simulated callers).
      const named = app.chat.callerNumberFromContext ? start.context.callerNumber?.trim() : undefined;
      const number = named !== undefined && E164.test(named) ? named : undefined;
      if (named !== undefined && number === undefined) io.record('log', { callerNumberRefused: 'not E.164' });
      c.state = newConverseState({ appId: app.id, callId: id, channel: 'chat', ...(number !== undefined ? { callerNumber: number, account: accountOf(app.business, number) } : {}) });
      try {
        io.send(io.ready(LANG));
        await run(id, c, { kind: 'start' }, io);
        if (start.token !== undefined && !io.ended) io.send(NO_SIGN_IN);
      } finally {
        turnEnded(id);
      }
    },

    resumed(id, start) {
      held(id).stream = start.stream;
    },

    async text(id, text, io) {
      try {
        return { ended: await run(id, held(id), { kind: 'text', text }, io) };
      } finally {
        turnEnded(id);
      }
    },

    async left(id, why) {
      const c = held(id);
      // The turn's own record of a caller leaving (converse_left, a read-back waiting dropped), then the end.
      try {
        await converseTurn(c.state, { kind: 'left' }, turnDeps(id, c), { say() {}, end() {} });
      } finally {
        audited(id, why === 'caller' ? 'hangup' : 'abandoned');
      }
    },

    abandoned(saved) {
      // A read-back that was waiting for its answer is dropped, nothing having run: recorded as a caller leaving
      // records it (converse_left), before the end.
      const state = saved.schema === CONVERSE_SCHEMA ? stateOf(saved.session) : null;
      if (state?.pending == null) return void audited(saved.id, 'abandoned');
      let left: unknown;
      try {
        left = deps.audit.append(saved.id, 'chat', { type: 'converse_left', detail: { pending: state.pending.action } });
      } catch (err) {
        log(`chat ${saved.id}: the dropped read-back's audit entry failed: ${describeError(err)}`);
      }
      if (left instanceof Promise) {
        left.then(
          () => audited(saved.id, 'abandoned'),
          (err: unknown) => {
            log(`chat ${saved.id}: the dropped read-back's audit entry failed: ${describeError(err)}`);
            audited(saved.id, 'abandoned');
          },
        );
      } else audited(saved.id, 'abandoned');
    },

    judge(saved) {
      const session = saved.session as { appId?: unknown } | null;
      const appId = typeof session === 'object' && session !== null ? session.appId : undefined;
      if (appId !== app.id) return 'other';
      const state = saved.schema === CONVERSE_SCHEMA ? stateOf(saved.session) : null;
      if (state === null) return 'unreadable';
      return state.ended !== undefined ? 'ended' : 'mine';
    },

    restore(id, saved) {
      const state = stateOf(saved.session);
      if (state === null) return false;
      chats.set(id, { state: structuredClone(state), trace: take(id), stream: false });
      return true;
    },

    snapshot(id) {
      return { schema: CONVERSE_SCHEMA, session: held(id).state, auditTail: [] };
    },

    locale: () => LANG,

    // A converse app names no call data keys: every key of a start's context is redacted in the frame log.
    callData: () => undefined,

    // The caller's words are kept as the trace keeps them (ConverseTraceRecord.said).
    typed: (_id, text) => text,

    forget(id) {
      chats.delete(id);
      prepared.delete(id);
    },
  };
}

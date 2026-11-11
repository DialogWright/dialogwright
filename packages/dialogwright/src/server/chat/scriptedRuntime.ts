import { WEB_CHAT } from '../../channel/caps';
import { signedInEvent, startEvent, textEvent, withCallData, type SessionEvent } from '../../channel/events';
import { callDataFrom } from '../../channel/callData';
import { actionsToChatMessages, type ServerMessage } from '../../channel/chat/protocol';
import { appOf } from '../../core/app/registry';
import { codeLengthOf } from '../../core/app/lookup';
import { defaultLocaleOf, localeOf } from '../../core/locale';
import type { Scrub } from '../../core/recording';
import { newSession, SESSION_SCHEMA, type Session } from '../../core/session';
import { maskSpokenCode, spokenCodeMinDigits } from '../../core/spokenCode';
import { isAnonymous, type Party } from '../../gate/types';
import { whenChained, type RunOptions, type TurnRun } from '../../run/turn';
import { framesMaskWords, summaryTexts, turnScrubber } from '../../trace/redact';
import type { EarlyLines } from '../../render/turn';
import { runChatTurnRuns, type ChatTurnDeps, type ChatTurnEntry } from '../chatTurn';
import type { ChatSettings } from '../config';
import type { ObservedCalls } from '../dashboard/observer';
import type { FrameSink } from '../frameLog';
import { jwksKeys } from './jwks';
import { isDelegate, principalForToken, type ChatSignIn } from './signin';
import type { KeyObject } from 'node:crypto';
import { CHAT_TURN_ERROR, type ChatIo, type ChatRuntime } from './runtime';

/**
 * The scripted runtime of the web chat: each chat a session of the engine's own (core/session.ts) on the
 * web chat channel (WEB_CHAT), run turn by turn through the path an app's own chat takes (chatTurn.ts),
 * with its trace, audit, console and handoff summary, and its sign-in (CHAT_SIGNIN). The transport
 * (chat/socket.ts) holds the socket; this holds each chat's session.
 */

/** Who the console says a chat's handoff goes to: the site decides (a live-chat desk, a phone number, a form). */
const HANDOFF_TO = 'the site';

/** What the server makes for a new chat session: its run options (client, tools, trace, audit, console) and its frame log. */
export interface ChatResources {
  opts: RunOptions;
  frames: FrameSink;
}

/** What the scripted runtime needs: the turn's own (ChatTurnDeps) and the chat's settings, sign-in and resources. */
export interface ScriptedChatDeps extends ChatTurnDeps {
  settings: ChatSettings;
  /** The app this endpoint's chats are in, on a server of several apps; absent, the default app. */
  appId?: string;
  now: () => number;
  /** A new session's resources, by its id; `sessions` is where the console's observer finds it. */
  resources(id: string, sessions: ObservedCalls): ChatResources;
  /** How the identity provider's published keys are fetched (CHAT_SIGNIN=jwt); tests serve their own. */
  fetch?: typeof fetch;
  /** The key lookup for a JWKS URL (CHAT_SIGNIN=jwt), shared by the endpoints of a server of several apps; absent, this runtime's own. */
  keysFor?: (url: string) => (kid: string) => Promise<KeyObject | null>;
}

/** One chat session as this runtime holds it: the turn's entry, its frame log, and the transport's counts. */
interface ScriptedEntry extends ChatTurnEntry {
  readonly io: ChatIo;
  readonly frames: FrameSink;
  readonly restores: number;
  readonly movedAway: boolean;
}

/** An entry whose activity, frame log and counts are the transport's own (the idle sweep and the trace's names read them there). */
function entryOf(id: string, session: Session, auditEntries: ChatTurnEntry['auditEntries'], opts: RunOptions, io: ChatIo): ScriptedEntry {
  return {
    id,
    session,
    auditEntries,
    opts,
    io,
    get lastActivityMs() {
      return io.lastActivityMs;
    },
    set lastActivityMs(ms: number) {
      io.lastActivityMs = ms;
    },
    get frames() {
      return io.frames;
    },
    get restores() {
      return io.restores;
    },
    get movedAway() {
      return io.movedAway;
    },
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A token checked: the principal it names, or the error the client is sent (with a reason that never carries the token). */
type Verified = { ok: true; principal: Party } | { ok: false; error: ServerMessage };

const refusal = (reason: string): ServerMessage => ({ type: 'error', code: 'sign_in_failed', message: `the sign-in was refused (${reason})` });

/** Whether the session is now signed in as `p`: the core took the sign-in (core/turn.ts auth.signed_in). */
function signedInAs(e: { session: { principal: unknown } }, p: Party): boolean {
  const q = e.session.principal as Partial<Party>;
  return q.kind === p.kind && q.id === p.id && q.level === p.level;
}

export function scriptedChatRuntime(deps: ScriptedChatDeps): ChatRuntime {
  const { log, now } = deps;
  const how = deps.settings.signIn;
  const signIn: ChatSignIn = how.method === 'jwt'
    ? { method: 'jwt', keyFor: deps.keysFor ? deps.keysFor(how.jwksUrl) : jwksKeys({ url: how.jwksUrl, fetch: deps.fetch, nowMs: now, log }), issuer: how.issuer, audience: how.audience }
    : how;
  const entries = new Map<string, ScriptedEntry>();
  /** Where the console's observer and the trace's names find a chat's session. */
  const observed: ObservedCalls = { get: (sid) => entries.get(sid) };
  /** Each chat's run options, made with its frame log (prepare) and taken when the chat is held (create, restore). */
  const prepared = new Map<string, RunOptions>();
  const take = (id: string): RunOptions => {
    const opts = prepared.get(id);
    if (opts === undefined) throw new Error(`chat ${id}: no resources prepared`);
    prepared.delete(id);
    return opts;
  };
  const held = (id: string): ScriptedEntry => {
    const e = entries.get(id);
    if (e === undefined) throw new Error(`chat ${id}: not held by this runtime`);
    return e;
  };
  const sendTo = (e: ScriptedEntry, m: ServerMessage, scrub: Scrub | null = null): void => e.io.send(m, scrub, appOf(e.session));

  /**
   * One turn (and any a downstream service's answer runs after it), with what it said sent; the
   * session finished if it ended. `before` is sent ahead of the turn's lines, read once the turn has
   * run (the opening turn's ready names the language the turn chose).
   */
  const turn = async (e: ScriptedEntry, event: SessionEvent, ahead?: (e: ScriptedEntry) => ServerMessage[]): Promise<void> => {
    const before = ahead ?? ((): ServerMessage[] => []);
    // A knowledge answer still being worded when its line's budget ran out (render/turn.ts): the lines
    // before it and the hold line are shown now, and the answer when it is ready. Not on a turn that sends
    // something ahead of its lines (the opening, a sign-in), which is read only once the turn has run.
    const early: EarlyLines | undefined = ahead !== undefined ? undefined : (lines, result) => {
      if (!e.io.connected()) return false;
      const app = appOf(result.session);
      const scrub = turnScrubber(result.session, result.decision, 'length', app, []);
      for (const m of actionsToChatMessages(lines, defaultLocaleOf(app), { slots: false })) sendTo(e, m, scrub);
      return true;
    };
    let runs: TurnRun[];
    try {
      runs = await runChatTurnRuns(deps, e, event, now, HANDOFF_TO, early);
    } catch (err) {
      log(`chat ${e.id}: turn failed: ${describeError(err)}`);
      // The client is told first, whatever the log can take.
      for (const m of before(e)) sendTo(e, m);
      sendTo(e, { type: 'error', code: 'server_error', message: CHAT_TURN_ERROR });
      e.io.record('log', { turnFailed: describeError(err) });
      return;
    }
    // The app's start hook threw (App.onStart): said by its kind, never its message; the chat went on.
    for (const r of runs) {
      if (r.result.startHookFailed === undefined) continue;
      log(`chat ${e.id}: the app's start hook failed (${r.result.startHookFailed}); the chat goes on`);
      e.io.record('log', { startHookFailed: r.result.startHookFailed });
    }
    for (const m of before(e)) sendTo(e, m);
    let last: ServerMessage['type'] | null = null;
    for (const r of runs) {
      const app = appOf(r.result.session);
      // Built from the session after the turn and its decision, as the voice frame log's is.
      const scrub = turnScrubber(r.result.session, r.result.decision, 'length', app, summaryTexts(r.record.render, app));
      // The collected slots go with a transfer only where the app's handoff data says (handoff.data.chat: send).
      // The lines shown before the turn ended (a hold line and those before it) are not shown again.
      for (const m of actionsToChatMessages(r.result.actions.slice(r.early ?? 0), defaultLocaleOf(app), { slots: app.handoff?.data?.chat === 'send' })) {
        sendTo(e, m, scrub);
        last = m.type;
      }
    }
    if (e.session.ended) {
      // A transfer ends the session too: the client is told it is over either way.
      if (last !== 'end') sendTo(e, { type: 'end' });
      e.io.finish(runs.at(-1)?.result.decision.kind ?? 'ended');
    } else e.io.save();
  };

  /** A token checked against the deployment's method and the app's rule; a refusal logged by its reason, never the token. */
  const verify = async (e: ScriptedEntry, token: string): Promise<Verified> => {
    if (signIn.method === 'none') return { ok: false, error: { type: 'error', code: 'not_allowed', message: 'sign-in is off for this chat' } };
    let r: Awaited<ReturnType<typeof principalForToken>>;
    try {
      r = await principalForToken(appOf(e.session), signIn, token, Math.floor(now() / 1000));
    } catch (err) {
      // The app's own code (principals.fromClaims, subjectPrincipal) threw: a refusal, not a chat that never opens.
      log(`chat ${e.id}: sign-in failed in the app's code: ${describeError(err)}`);
      r = { ok: false, reason: 'the app could not read the token' };
    }
    if (!r.ok) {
      log(`chat ${e.id}: sign-in refused (${r.reason})`);
      e.io.record('log', { signInRefused: r.reason });
      return { ok: false, error: refusal(r.reason) };
    }
    return { ok: true, principal: r.principal };
  };

  /** A subject signs in: the core's auth.signed_in turn, and signed_in ahead of its lines only if the core took it. */
  const signInTurn = async (e: ScriptedEntry, p: Party): Promise<void> => {
    if (!isAnonymous(e.session.principal)) {
      sendTo(e, refusal('the chat is already signed in'));
      return;
    }
    await turn(e, signedInEvent(p), (s) => {
      if (!signedInAs(s, p)) return [refusal('the chat could not take this sign-in')];
      log(`chat ${s.id}: signed in (${p.kind}, level ${p.level})`);
      s.io.record('log', { signedIn: p.level, kind: p.kind });
      return [{ type: 'signed_in', level: p.level }];
    });
  };

  /** A sign-in after the start (a sign_in message, or a resume's token on a chat still anonymous): a subject only, since a delegate's chat begins as theirs. */
  const laterSignIn = async (e: ScriptedEntry, token: string): Promise<void> => {
    const r = await verify(e, token);
    if (!r.ok) {
      sendTo(e, r.error);
      return;
    }
    if (isDelegate(appOf(e.session), r.principal)) {
      sendTo(e, refusal('a delegate signs in as the chat starts'));
      return;
    }
    await signInTurn(e, r.principal);
  };

  const ready = (e: ScriptedEntry): ServerMessage[] => [e.io.ready(localeOf(e.session))];

  return {
    prepare(id) {
      const { opts, frames } = deps.resources(id, observed);
      prepared.set(id, opts);
      return frames;
    },

    create(id, io) {
      const opts = take(id);
      const e = entryOf(id, deps.appId === undefined ? newSession(id, now(), WEB_CHAT) : newSession(id, now(), WEB_CHAT, undefined, deps.appId), [], opts, io);
      entries.set(id, e);
      // Ahead of the opening turn, and it is what resets the console's history: the page follows this chat now.
      deps.bus?.publish({ type: 'call_started', callSid: id, at: now(), from: 'web chat', todayIso: opts.todayIso, thresholds: opts.thresholds, channel: 'chat', caller: null, ...(deps.appId !== undefined ? { app: deps.appId } : {}) });
    },

    async open(id, start) {
      const s = held(id);
      // A token on start: a delegate's chat begins as theirs (as the harness's `as` does); a subject signs
      // in through the core once the chat has opened, as a later sign-in does.
      let refused: ServerMessage | null = null;
      let subject: Party | null = null;
      let delegate: Party | null = null;
      if (start.token !== undefined) {
        const r = await verify(s, start.token);
        if (!r.ok) refused = r.error;
        else if (isDelegate(appOf(s.session), r.principal)) delegate = r.principal;
        else subject = r.principal;
      }
      if (delegate !== null) {
        s.session = newSession(s.id, s.session.startedAtMs, WEB_CHAT, delegate, s.session.appId);
        log(`chat ${s.id}: signed in (${delegate.kind}, level ${delegate.level})`);
        s.io.record('log', { signedIn: delegate.level, kind: delegate.kind });
      }
      const signedIn: ServerMessage[] = delegate === null ? [] : [{ type: 'signed_in', level: delegate.level }];
      // The client asks for a language; the core matches it to one of the app's (core/locale.ts matchLocale),
      // and ready names the one the session speaks.
      // The page's context, by the app's callData keys (chat.<key>); none for an app that names none.
      const data = callDataFrom(appOf(s.session).callData, {}, start.context);
      await turn(s, withCallData(startEvent({ channel: 'chat' }, start.locale), data), (x) => [...ready(x), ...signedIn]);
      if (refused !== null) sendTo(s, refused);
      if (subject !== null && !s.io.ended) await signInTurn(s, subject);
    },

    // A scripted chat sends each reply's lines whole: nothing a resume asks changes it.
    resumed() {},

    async text(id, text) {
      const e = held(id);
      await turn(e, textEvent(text));
      return { ended: e.io.ended };
    },

    async signIn(id, token, _io, resumed) {
      const e = held(id);
      // A resume keeps the sign-in the chat had: its token signs in only a chat still anonymous.
      if (resumed && !isAnonymous(e.session.principal)) return;
      await laterSignIn(e, token);
    },

    async left(id, why) {
      const e = held(id);
      if (why === 'caller') {
        // Recorded as a voice caller's hangup is (the audit's call_ended, reason hangup, with the tasks completed; the console's ended).
        whenChained(deps.audit.append(e.id, 'chat', { type: 'call_ended', detail: { reason: 'hangup', completed: [...e.session.completed] } }), (entry) => e.auditEntries.push(entry),
          (err: unknown) => log(`chat ${e.id}: the end's audit entry failed: ${describeError(err)}`));
        deps.bus?.publish({ type: 'ended', callSid: e.id, at: now(), reason: 'hangup' });
        return;
      }
      whenChained(deps.audit.append(e.id, 'chat', { type: 'call_ended', detail: { reason: 'abandoned' } }), (entry) => e.auditEntries.push(entry),
        (err: unknown) => log(`chat ${e.id}: the idle end's audit entry failed: ${describeError(err)}`));
      deps.bus?.publish({ type: 'ended', callSid: e.id, at: now(), reason: 'abandoned' });
    },

    abandoned(saved) {
      whenChained(deps.audit.append(saved.id, 'chat', { type: 'call_ended', detail: { reason: 'abandoned' } }), () => {},
        (err: unknown) => log(`chat ${saved.id}: the abandoned chat's audit entry failed: ${describeError(err)}`));
    },

    judge(saved) {
      const session = saved.session as Partial<Session> | null;
      // On a host, a chat is resumed only at its own app's path: another app's is not this endpoint's to take.
      if (deps.appId !== undefined && session?.appId !== deps.appId) return 'other';
      let readable = saved.schema === SESSION_SCHEMA;
      if (readable) {
        try {
          appOf(session as Session);
        } catch {
          readable = false;
        }
      }
      if (!readable) return 'unreadable';
      return session?.ended ? 'ended' : 'mine';
    },

    restore(id, saved, io) {
      const e = entryOf(id, saved.session as Session, [...saved.auditTail], take(id), io);
      entries.set(id, e);
      return true;
    },

    snapshot(id) {
      const e = held(id);
      return { schema: SESSION_SCHEMA, session: e.session, auditTail: [...e.auditEntries] };
    },

    locale: (id) => localeOf(held(id).session),

    callData: (id) => appOf(held(id).session).callData,

    typed(id, text) {
      const e = held(id);
      // A one-time code typed at the code prompt is masked before the frame log sees it, as a spoken one is (adapter.ts maskCodeFrame).
      // An app with a slot the records mask whose words a model summarizes keeps no typed words in the frame log (trace/redact.ts framesMaskWords).
      return framesMaskWords(appOf(e.session)) ? `<${text.length} chars>` : e.session.promptedFor === 'otp' ? maskSpokenCode(text, spokenCodeMinDigits(codeLengthOf(appOf(e.session)))).text : text;
    },

    forget(id) {
      entries.delete(id);
      prepared.delete(id);
    },
  };
}


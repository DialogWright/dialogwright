import type { ServerMessage } from '../../channel/chat/protocol';
import type { CallDataKey, App } from '../../core/app/types';
import type { Scrub } from '../../core/recording';
import type { FrameSink } from '../frameLog';
import type { StoredChat } from '../stores/types';

/**
 * The web chat in two parts: the transport (chat/socket.ts chatTransport: the socket, the wire, resume
 * tokens, the session store's saves, the idle sweep, a stop's drain) and a runtime per app that runs
 * each chat's turns, keeping what it needs of each chat by its id. The scripted runtime
 * (chat/scriptedRuntime.ts) is the engine's turn as it always ran on the chat; the converse runtime
 * (chat/converseRuntime.ts) is an app whose model holds the conversation (src/converse).
 */

/** What a chat is told when a turn throws: a retry, rather than silence. */
export const CHAT_TURN_ERROR = 'Sorry, something went wrong on our side. Please send that again.';

/** What a client's `start` asks of a new chat. */
export interface ChatStart {
  /** The language the client asks for (`start.locale`). */
  locale?: string;
  /** The page's own data (`start.context`), as it came; {} when it sent none. */
  context: Record<string, string>;
  /** A sign-in token sent with the start. */
  token?: string;
  /** The client takes a reply's sentences as they are ready (`say_delta`), before the reply's `say`. */
  stream: boolean;
}

/**
 * One chat as its runtime sees the transport: where its messages go, its frame log, its resume, and its
 * end. The transport makes one for each chat it holds, for as long as it holds it.
 */
export interface ChatIo {
  readonly id: string;
  readonly frames: FrameSink;
  /** How many times a server restored the chat from the store (StoredChat.restores). */
  readonly restores: number;
  /** Let go to a server that restored it later. */
  readonly movedAway: boolean;
  /** Whether the chat is over here (ended, or let go). */
  readonly ended: boolean;
  /** When someone last did something in the chat (CHAT_IDLE_MS counts from it). */
  lastActivityMs: number;
  /**
   * One message to the chat's socket, written to its frame log (a line scrubbed by `scrub`, a transfer's
   * values as `app` records them); kept in the frame log as dropped when no socket is open.
   */
  send(m: ServerMessage, scrub?: Scrub | null, app?: App | null): void;
  /** The `ready` a client is sent: the chat's id, its resume token now, and the language it speaks. */
  ready(locale: string): ServerMessage;
  /** A line in the chat's frame log; a failure to write it is logged, never thrown. */
  record(dir: 'in' | 'out' | 'log', msg: unknown): void;
  /** Whether a socket is open for the chat now. */
  connected(): boolean;
  /** The chat saved as it is now (nothing without a session store). */
  save(): void;
  /** The chat is over: forgotten, its saved copy removed, its socket closed once what was sent has gone. */
  finish(reason: string): void;
}

/** A saved chat's own part: what a runtime keeps of it in the store. */
export type ChatSnapshot = Pick<StoredChat, 'schema' | 'session' | 'auditTail'>;

/**
 * A chat runtime: the turns of each chat of one app, by the chat's id. The transport calls one method at
 * a time per chat (each in the chat's queue, but `create`, `restore`, `snapshot`, `forget` and the
 * frame-log helpers, which are synchronous).
 */
export interface ChatRuntime {
  /** A chat's frame log and its other resources, as it starts on this server (a new chat, or one restored). */
  prepare(id: string): FrameSink;
  /** A new chat is held here (before its start is written to the frame log and its opening queued). */
  create(id: string, io: ChatIo): void;
  /** A new chat's opening: `ready`, then its first lines, through `io`. */
  open(id: string, start: ChatStart, io: ChatIo): Promise<void>;
  /**
   * The chat is taken up again by a client (a resume on this server, or one restored from the store):
   * what its `start` asks now, the resuming client's own (`stream`), over what the chat started with.
   */
  resumed(id: string, start: Pick<ChatStart, 'stream'>): void;
  /** What the person typed: the turn, its lines sent through `io`; `ended` when the chat ended with it. */
  text(id: string, text: string, io: ChatIo): Promise<{ ended: boolean }>;
  /**
   * A sign-in after the start: a `sign_in` message, or the token beside a resume (`resumed`: used only on
   * a chat not yet signed in). Absent: the chat takes no sign-in.
   */
  signIn?(id: string, token: string, io: ChatIo, resumed: boolean): Promise<void>;
  /**
   * The chat ends with no turn of its own: the person ended it (`caller`) or it went idle (`idle`). Its
   * end is recorded here (the audit, the console); the transport then tells the client `end` and
   * forgets the chat. Synchronous up to its first await, so what it records is the chat as it was.
   */
  left(id: string, why: 'caller' | 'idle'): Promise<void>;
  /** A chat saved before a restart and never resumed, past CHAT_IDLE_MS: its end recorded. */
  abandoned(saved: StoredChat): void;
  /**
   * Whose a saved chat is: this runtime's to resume (`mine`), another endpoint's to leave alone
   * (`other`), this app's but unreadable here (`unreadable`: forgotten, and logged), or over (`ended`:
   * forgotten).
   */
  judge(saved: StoredChat): 'mine' | 'other' | 'unreadable' | 'ended';
  /** A saved chat judged `mine`, held here again; false when it cannot be. */
  restore(id: string, saved: StoredChat, io: ChatIo): boolean;
  /** The chat's own part as it is saved (schema, session, audit tail). */
  snapshot(id: string): ChatSnapshot;
  /** The language the chat speaks now (a resume's `ready`). */
  locale(id: string): string;
  /** The app's call data keys a start's context is recorded by in the frame log; none: every key redacted. */
  callData(id: string): Readonly<Record<string, CallDataKey>> | undefined;
  /** What the frame log keeps of words the person typed. */
  typed(id: string, text: string): string;
  /** The chat is no longer held here (ended, or let go to another server). */
  forget(id: string): void;
}


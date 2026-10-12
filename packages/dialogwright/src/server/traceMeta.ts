import type { Session } from '../core/session';
import type { CallMeta } from '../trace/store';
import type { FrameSink } from './frameLog';

/** What the chat endpoint holds for a chat, as far as its trace's names need it (chat/socket.ts ChatEntry). */
export interface ChatSeen {
  session: Session;
  frames?: FrameSink;
  restores?: number;
  movedAway?: boolean;
}

/**
 * The trace store's names for one chat on this server (trace/store.ts CallMeta): read from the entry the
 * chat endpoint has for the chat while it is the one these sinks are for (`bind` names the frame sink);
 * once it is no longer there (ended, or let go to another server), the last values it had, so the
 * lines it still writes (its end, its let-go) carry its last turn and start day, never turn 0. The
 * generation is the chat's restores (StoredChat.restores); what it writes after it was let go to
 * another server is late.
 */
export function chatTraceMeta(id: string, sessions: { get(id: string): unknown }, now: () => number): { meta: () => CallMeta; bind(frames: FrameSink): void } {
  let mine: FrameSink | null = null;
  let entry: ChatSeen | null = null;
  let last: Omit<CallMeta, 'held'> = { turn: 0, gen: 0, startedAtMs: now() };
  return {
    meta: () => {
      const e = sessions.get(id) as ChatSeen | undefined;
      if (e !== undefined && mine !== null && e.frames === mine) {
        entry = e;
        last = { turn: e.session.turnIndex, gen: e.restores ?? 0, startedAtMs: e.session.startedAtMs };
      }
      // Its own to the end (an ended chat's last lines are never late), unless it was let go to another server.
      return { ...last, held: entry?.movedAway !== true };
    },
    bind(frames) {
      mine = frames;
    },
  };
}

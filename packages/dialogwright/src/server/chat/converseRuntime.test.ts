import { describe, expect, it } from 'vitest';
import type { AuditSink } from '../../audit/sink';
import type { AuditDraft } from '../../audit/types';
import { fakeModel } from '../../converse/model/fake';
import { newConverseState, type ConverseState } from '../../converse/state';
import type { JevClient } from '../../jev/types';
import { converseFixture } from '../../testing/converse/app';
import type { StoredChat } from '../stores/types';
import { CONVERSE_SCHEMA, converseChatRuntime } from './converseRuntime';

/** A converse chat's end with no turn of its own: a chat saved before a restart and never resumed. */

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

import type { AuditSink } from '../audit/sink';
import type { AuditDraft } from '../audit/types';
import type { ConverseApp } from '../converse/app';
import type { ConverseModel } from '../converse/model/types';
import { policyOf } from '../converse/policy';
import { accountOf } from '../converse/sources/accounts';
import { converseTexts } from '../converse/sources/texts';
import { newConverseState, type ConverseState } from '../converse/state';
import type { ConverseTraceRecord } from '../converse/trace';
import { converseTurn, type ConverseDeps, type Out } from '../converse/turn';
import type { JevClient } from '../jev/types';
import { TextKeys, textAuditRow } from '../texts/record';
import type { TextProvider } from '../texts/types';

/**
 * One conversation with a converse app in its own tests (docs/designs/2026-11-11-agent-runtime.md): the
 * app's agent.yaml, its code and its gate, run turn by turn as the server's chat runs them, with the
 * test's model (a script: fakeConverseModel), the test's decision model reading each read-back's answer,
 * and, where the test gives them, a caller's number, a clock, the app's settings and a fake text sender.
 * Nothing calls a real model, carrier or calendar. What the line said each turn is returned; the audit's
 * rows and the trace's records are kept.
 */

export interface ConverseTestCallOptions {
  /** The model that holds the conversation: a script (fakeConverseModel). */
  model: ConverseModel;
  /** The decision model that reads the caller's answer to a read-back. */
  jev: JevClient;
  /** The number the caller is calling from (E.164); absent, none (a chat's). */
  callerNumber?: string;
  /** The channel the conversation is on; default 'chat'. */
  channel?: 'chat' | 'voice';
  /** The clock; default the real one. */
  now?: () => Date;
  /** The app's settings its code reads (ctx.env). */
  env?: Readonly<Record<string, string>>;
  /** A text sender for the app's code (fakeTextProvider); absent, the code has none. */
  texts?: TextProvider;
  /** The number the texts are sent from; default +15555550100. */
  textFrom?: string;
  /** The call's id; default "test-call". */
  callId?: string;
  /** How long the decision model may take; default 1000 ms. */
  jevTimeoutMs?: number;
}

export interface ConverseTestCall {
  /** The call starts: the greeting. Returns what the line said. */
  start(): Promise<string[]>;
  /** The caller says `text`. Returns what the line said, piece by piece as it was said. */
  say(text: string): Promise<string[]>;
  /** The caller leaves. */
  leave(): Promise<void>;
  /** The conversation as it stands. */
  readonly state: ConverseState;
  /** How the call ended, or undefined while it goes on. */
  readonly ended: ConverseState['ended'];
  /** The audit's rows, in order. */
  readonly audit: readonly AuditDraft[];
  /** The trace's records, one a turn. */
  readonly traces: readonly ConverseTraceRecord[];
}

export function converseTestCall(app: ConverseApp, o: ConverseTestCallOptions): ConverseTestCall {
  const now = o.now ?? (() => new Date());
  const callId = o.callId ?? 'test-call';
  const channel = o.channel ?? 'chat';
  const audit: AuditDraft[] = [];
  const traces: ConverseTraceRecord[] = [];
  const sink: AuditSink = {
    append(id, ch, d) {
      audit.push(d);
      return { ...d, seq: audit.length, at: now().toISOString(), callId: id, channel: ch, prevHash: '', hash: '' };
    },
  };
  const env = o.env ?? {};
  const deps: ConverseDeps = {
    business: app.business,
    model: o.model,
    jev: o.jev,
    policy: policyOf(app.business),
    audit: sink,
    tools: app.tools,
    texts: o.texts === undefined ? null : converseTexts({ provider: o.texts, from: o.textFrom ?? '+15555550100', keys: new TextKeys() }, (r) => void audit.push(textAuditRow(r))),
    now,
    trace: (r) => void traces.push(r),
    jevTimeoutMs: o.jevTimeoutMs ?? 1000,
    env: (name) => (Object.hasOwn(env, name) ? env[name] : undefined),
  };
  let state = newConverseState({
    appId: app.id, callId, channel,
    ...(o.callerNumber !== undefined ? { callerNumber: o.callerNumber, account: accountOf(app.business, o.callerNumber) } : {}),
  });
  const turn = async (input: Parameters<typeof converseTurn>[1]): Promise<string[]> => {
    const said: string[] = [];
    const out: Out = { say: (text) => void said.push(text), end: () => {} };
    state = await converseTurn(state, input, deps, out);
    return said;
  };
  return {
    start: () => turn({ kind: 'start' }),
    say: (text) => turn({ kind: 'text', text }),
    leave: async () => void (await turn({ kind: 'left' })),
    get state() {
      return state;
    },
    get ended() {
      return state.ended;
    },
    audit,
    traces,
  };
}

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isConverseApp, type ConverseApp } from '../converse/app';
import type { ConverseModel, ModelEffort } from '../converse/model/types';
import type { Opener } from '../converse/business/schema';
import { loadConfig } from '../server/config';
import { hostRouting, type HostedApp } from '../server/host';
import { startServer, type RunningServer, type ServerOverrides } from '../server/index';
import type { TextProvider } from '../texts/types';
import type { JevClient } from '../jev/types';
import { turnEndSignal, type TurnEnds } from './chatDriver';

/**
 * The server a simulated call runs on (pnpm eval): in this process, its audit and traces in folders under
 * `work`, its texts to a fake sender. An agent app gets a server of its own for each call, on the app made
 * fresh (ConverseApp.fresh), so no call sees what another booked, and its chat takes the number a persona
 * calls from out of the start's context (chat.callerNumberFromContext), whatever app.yaml says; its model is
 * the one a run names (eval:compare), its opener the one a run names (eval --opener), and its model's time the eval's own (EVAL_MODEL_TIMEOUT_MS). Each is the
 * harness's own override, given to this server alone, never a setting a deployment can have. A scripted app
 * runs on one server for the whole run, as it is registered. Either way the server tells each chat turn's end
 * (ServerOverrides.onTurnEnd) to `turnEnds`, which the driver ends each reply on (eval/chatDriver.ts). On the voice
 * path (`channel: 'voice'`, an agent app only) the server also takes calls on Twilio, its webhooks unsigned
 * (voiceEnv), and tells each call turn's end the same way (eval/voiceDriver.ts).
 */

/**
 * The model's time in an evaluation: long enough that each request runs to its end and its true time is
 * recorded, so the effect of any timeout is worked out from the same data (eval/measures.ts wouldTimeOut). The
 * harness's own, given to its servers alone: never a setting a deployment has, whose timeout stays its own.
 */
export const EVAL_MODEL_TIMEOUT_MS = 30_000;

/** The model a run asks in place of the app's own (eval:compare): its spec, and its effort (null: none sent; absent: the app's). */
export interface EvalModel {
  default: string;
  effort?: ModelEffort | null;
}

/** The persona's style a run asks for in place of the app's own (agent.yaml persona.opener). */
export interface EvalStyle {
  opener?: Opener;
}

/** An agent app as an evaluation runs it: the model and the opener a run names, if it names them, and the eval's long timeout. The app given is left as it is. */
export function evalApp(app: ConverseApp, model?: EvalModel, style: EvalStyle = {}): ConverseApp {
  const { effort: own, ...rest } = app.business.model;
  const effort = model?.effort === undefined ? own : model.effort ?? undefined;
  return {
    ...app,
    business: {
      ...app.business,
      ...(style.opener !== undefined ? { persona: { ...app.business.persona, opener: style.opener } } : {}),
      model: { ...rest, ...(model ? { default: model.default } : {}), ...(effort !== undefined ? { effort } : {}), timeoutMs: EVAL_MODEL_TIMEOUT_MS },
    },
  };
}

/** The wire a simulated call goes over: the chat's, or the phone path's (Twilio's relay, in text: eval/voiceDriver.ts). */
export type EvalChannel = 'chat' | 'voice';
export const EVAL_CHANNELS: readonly EvalChannel[] = ['chat', 'voice'];

/** The phone path's settings on an evaluation's server: Twilio on, its webhooks unsigned (the driver signs nothing), a person's number for a handoff. */
export function voiceEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, VOICE_PROVIDERS: 'twilio', SIGNATURE_CHECK: 'off', TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN || 'eval-not-a-token', HANDOFF_NUMBER: env.HANDOFF_NUMBER || '+15555550199' };
}

export interface EvalServer {
  /** The chat's address. */
  url: string;
  /** The server's http address: a carrier's webhooks (POST /voice/twilio) on the voice path. */
  http: string;
  /** The server's socket address, which the relay's path (the start document's) is opened on. */
  ws: string;
  auditDir: string;
  traceDir: string;
  /** Each turn's end on this server, a chat's or a call's, for the driver (driveChat's and driveVoice's turnEnds). */
  turnEnds: TurnEnds;
  close(): Promise<void>;
}

let started = 0;

export async function startEvalServer(app: HostedApp, env: Record<string, string | undefined>, o: { work: string; channel?: EvalChannel; client?: JevClient; textProvider?: TextProvider; converseModel?: (appId: string) => ConverseModel; model?: EvalModel; style?: EvalStyle; onClaimsRead?: ServerOverrides['onClaimsRead'] }): Promise<EvalServer> {
  const dir = join(o.work, `server-${++started}`);
  const auditDir = join(dir, 'audit');
  const traceDir = join(dir, 'traces');
  mkdirSync(dir, { recursive: true });
  const voice = o.channel === 'voice';
  // The voice path runs on the converse runtime alone (its turns' ends are what the driver ends a reply on).
  if (voice && !isConverseApp(app)) throw new Error(`the voice path is for an agent app (app.yaml mode: agent); ${app.id} is a scripted app`);
  const serverEnv: Record<string, string | undefined> = { ...(voice ? voiceEnv(env) : env), AUDIT_DIR: auditDir, TRACE_DIR: traceDir };
  let running: RunningServer;
  const ends = turnEndSignal();
  const base = { host: '127.0.0.1', log: () => {}, env: serverEnv, onTurnEnd: ends.ended, ...(o.onClaimsRead !== undefined ? { onClaimsRead: o.onClaimsRead } : {}), ...(o.textProvider !== undefined ? { textProvider: o.textProvider } : {}), ...(o.client !== undefined ? { client: o.client } : {}) };
  if (isConverseApp(app)) {
    const made: ConverseApp = evalApp(app.fresh?.() ?? app, o.model, o.style);
    const call: ConverseApp = { ...made, chat: { ...made.chat, callerNumberFromContext: true } };
    const apps = hostRouting<HostedApp>({ apps: [{ id: call.id, app: call, dir: call.dir, env: serverEnv, own: [], ignored: [] }], numbers: [], defaultApp: call.id, env: serverEnv });
    running = await startServer(loadConfig(serverEnv), { ...base, apps, ...(o.converseModel !== undefined ? { converseModel: o.converseModel } : {}) });
  } else {
    running = await startServer(loadConfig(serverEnv), base);
  }
  return { url: `ws://127.0.0.1:${running.port}/chat`, http: `http://127.0.0.1:${running.port}`, ws: `ws://127.0.0.1:${running.port}`, auditDir, traceDir, turnEnds: ends, close: () => running.close() };
}

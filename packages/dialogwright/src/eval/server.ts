import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isConverseApp, type ConverseApp } from '../converse/app';
import type { ConverseModel, ModelEffort } from '../converse/model/types';
import type { Opener } from '../converse/business/schema';
import { loadConfig } from '../server/config';
import { hostRouting, type HostedApp } from '../server/host';
import { startServer, type RunningServer } from '../server/index';
import type { TextProvider } from '../texts/types';

/**
 * The server a simulated call runs on (pnpm eval): in this process, its audit and traces in folders under
 * `work`, its texts to a fake sender. A converse app gets a server of its own for each call, on the app made
 * fresh (ConverseApp.fresh), so no call sees what another booked, and its chat takes the number a persona
 * calls from out of the start's context (chat.callerNumberFromContext), whatever app.yaml says; its model is
 * the one a run names (eval:compare), its opener the one a run names (eval --opener), and its model's time the eval's own (EVAL_MODEL_TIMEOUT_MS). Each is the
 * harness's own override, given to this server alone, never a setting a deployment can have. A scripted app
 * runs on one server for the whole run, as it is registered.
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

/** A converse app as an evaluation runs it: the model and the opener a run names, if it names them, and the eval's long timeout. The app given is left as it is. */
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

export interface EvalServer {
  /** The chat's address. */
  url: string;
  auditDir: string;
  traceDir: string;
  close(): Promise<void>;
}

let started = 0;

export async function startEvalServer(app: HostedApp, env: Record<string, string | undefined>, o: { work: string; textProvider?: TextProvider; converseModel?: (appId: string) => ConverseModel; model?: EvalModel; style?: EvalStyle }): Promise<EvalServer> {
  const dir = join(o.work, `server-${++started}`);
  const auditDir = join(dir, 'audit');
  const traceDir = join(dir, 'traces');
  mkdirSync(dir, { recursive: true });
  const serverEnv: Record<string, string | undefined> = { ...env, AUDIT_DIR: auditDir, TRACE_DIR: traceDir };
  let running: RunningServer;
  const base = { host: '127.0.0.1', log: () => {}, env: serverEnv, ...(o.textProvider !== undefined ? { textProvider: o.textProvider } : {}) };
  if (isConverseApp(app)) {
    const made: ConverseApp = evalApp(app.fresh?.() ?? app, o.model, o.style);
    const call: ConverseApp = { ...made, chat: { ...made.chat, callerNumberFromContext: true } };
    const apps = hostRouting<HostedApp>({ apps: [{ id: call.id, app: call, dir: call.dir, env: serverEnv, own: [], ignored: [] }], numbers: [], defaultApp: call.id, env: serverEnv });
    running = await startServer(loadConfig(serverEnv), { ...base, apps, ...(o.converseModel !== undefined ? { converseModel: o.converseModel } : {}) });
  } else {
    running = await startServer(loadConfig(serverEnv), base);
  }
  return { url: `ws://127.0.0.1:${running.port}/chat`, auditDir, traceDir, close: () => running.close() };
}

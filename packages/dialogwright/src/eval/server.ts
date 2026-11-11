import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isConverseApp, type ConverseApp } from '../converse/app';
import type { ConverseModel } from '../converse/model/types';
import { loadConfig } from '../server/config';
import { hostRouting, type HostedApp } from '../server/host';
import { startServer, type RunningServer } from '../server/index';
import type { TextProvider } from '../texts/types';

/**
 * The server a simulated call runs on (pnpm eval): in this process, its audit and traces in folders under
 * `work`, its texts to a fake sender. A converse app gets a server of its own for each call, on the app made
 * fresh (ConverseApp.fresh), so no call sees what another booked, and its chat takes the number a persona
 * calls from out of the start's context (chat.callerNumberFromContext), whatever app.yaml says: the
 * harness's own override, given to this server alone, never a setting a deployment can have. A scripted app
 * runs on one server for the whole run, as it is registered.
 */

export interface EvalServer {
  /** The chat's address. */
  url: string;
  auditDir: string;
  traceDir: string;
  close(): Promise<void>;
}

let started = 0;

export async function startEvalServer(app: HostedApp, env: Record<string, string | undefined>, o: { work: string; textProvider?: TextProvider; converseModel?: (appId: string) => ConverseModel }): Promise<EvalServer> {
  const dir = join(o.work, `server-${++started}`);
  const auditDir = join(dir, 'audit');
  const traceDir = join(dir, 'traces');
  mkdirSync(dir, { recursive: true });
  const serverEnv: Record<string, string | undefined> = { ...env, AUDIT_DIR: auditDir, TRACE_DIR: traceDir };
  let running: RunningServer;
  const base = { host: '127.0.0.1', log: () => {}, env: serverEnv, ...(o.textProvider !== undefined ? { textProvider: o.textProvider } : {}) };
  if (isConverseApp(app)) {
    const made: ConverseApp = app.fresh?.() ?? app;
    const call: ConverseApp = { ...made, chat: { ...made.chat, callerNumberFromContext: true } };
    const apps = hostRouting<HostedApp>({ apps: [{ id: call.id, app: call, dir: call.dir, env: serverEnv, own: [], ignored: [] }], numbers: [], defaultApp: call.id, env: serverEnv });
    running = await startServer(loadConfig(serverEnv), { ...base, apps, ...(o.converseModel !== undefined ? { converseModel: o.converseModel } : {}) });
  } else {
    running = await startServer(loadConfig(serverEnv), base);
  }
  return { url: `ws://127.0.0.1:${running.port}/chat`, auditDir, traceDir, close: () => running.close() };
}

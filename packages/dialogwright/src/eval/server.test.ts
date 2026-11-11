import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defineConverseApp, type ConverseApp } from '../converse/app';
import { fakeModel } from '../converse/model/fake';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';
import { CALLER, done, text } from '../testing/converse/chat';
import { startEvalServer, type EvalServer } from './server';

/**
 * The server a simulated call runs on (eval/server.ts): for a converse app, a server of its own per call,
 * on the app made fresh, taking the number a persona calls from out of the chat's context whatever the
 * app's app.yaml says (the harness's override, never a setting a deployment has).
 */

const dirs: string[] = [];
const servers: EvalServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'eval-server-'));
  dirs.push(d);
  return d;
}

const ORIGIN = 'https://eval.example.com';
const env = (dir: string): Record<string, string> => ({ PUBLIC_HOST: 'localhost', VOICE_PROVIDERS: 'none', CHAT: 'on', CHAT_ALLOWED_ORIGINS: ORIGIN, PORT: '0', AUDIO_DIR: dir, DASHBOARD: 'off', JEV_CLIENT: 'stub' });

/** A converse app whose app.yaml says callerNumberFromContext: false (a deployment's), and a regular account on the number CALLER. */
function deployedApp(): string {
  const own = join(folder(), 'converse');
  mkdirSync(own);
  copyFileSync(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), join(own, 'agent.yaml'));
  writeFileSync(join(own, 'agent.yaml'), readFileSync(join(own, 'agent.yaml'), 'utf8').replace('sources:\n', `sources:\n  accounts:\n    - { name: Example Regular, numbers: ["${CALLER}"] }\n`));
  writeFileSync(join(own, 'app.yaml'), 'id: converse\nmode: converse\nchat:\n  callerNumberFromContext: false\n');
  return own;
}

/** Starts a chat naming CALLER in its context, says hello, and waits for the reply. */
async function chat(url: string): Promise<void> {
  const ws = new WebSocket(url, { origin: ORIGIN });
  await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
  const said: string[] = [];
  const arrived = (n: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => void (said.length >= n ? resolve() : setTimeout(check, 10));
    check();
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as { type: string };
    if (m.type === 'say') said.push('say');
  });
  ws.send(JSON.stringify({ type: 'start', v: 1, context: { callerNumber: CALLER } }));
  await arrived(1);
  ws.send(JSON.stringify({ type: 'text', text: 'hello' }));
  await arrived(2);
  ws.close();
}

describe('startEvalServer', () => {
  it('takes the number a persona calls from for a converse app whose app.yaml does not: the harness\'s override alone', async () => {
    const dir = deployedApp();
    const model = fakeModel([[text('Hello.'), done()]]);
    const app = defineConverseApp(dir, { tools: { availability: async () => [], book: async () => 'booked' } });
    expect(app.chat.callerNumberFromContext).toBe(false);
    const s = await startEvalServer(app, env(folder()), { work: folder(), converseModel: () => model });
    servers.push(s);
    await chat(s.url);
    expect(model.requests[0]!.system).toContain('on file for the account "Example Regular"');
    // The app itself is untouched: a server started from it as a deployment would be takes no number.
    expect(app.chat.callerNumberFromContext).toBe(false);
  });

  it('runs each call of a converse app on the app made fresh, with an audit and traces of its own', async () => {
    const dir = deployedApp();
    let made = 0;
    const make = (): ConverseApp => defineConverseApp(dir, { tools: { availability: async () => [], book: async () => 'booked' }, fresh: () => (made += 1, make()) });
    const app = make();
    const a = await startEvalServer(app, env(folder()), { work: folder(), converseModel: () => fakeModel([[text('Hi.'), done()]]) });
    servers.push(a);
    const b = await startEvalServer(app, env(folder()), { work: folder(), converseModel: () => fakeModel([[text('Hi.'), done()]]) });
    servers.push(b);
    expect(made).toBe(2);
    expect(a.auditDir).not.toBe(b.auditDir);
    expect(a.traceDir).not.toBe(b.traceDir);
  });
});

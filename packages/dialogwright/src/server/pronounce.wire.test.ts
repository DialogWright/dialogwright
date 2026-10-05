import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSocketMessage, newConnectionContext } from './adapter';
import { SessionStore } from './sessions';
import { CallTokens } from './tokens';
import { FrameLog } from './frameLog';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { TraceWriter } from '../trace/writer';
import type { TraceRecord } from '../trace/types';
import { VOICE_RELAY } from '../channel/caps';
import { registerApp } from '../core/app/registry';
import { useTestkit } from '../testing/apps';
import { ANONYMOUS } from '../gate/principal';
import { placeApp, placeClient } from '../testing/placeApp';
import type { App } from '../core/app/types';

useTestkit();

/** The place app (run/__fixtures__) under another id, with the voice settings a test gives it. */
function appWith(id: string, voice: App['voice']): App {
  const app = placeApp({ id, voice });
  registerApp(app);
  return app;
}

async function readBack(app: App, place: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pronounce-'));
  const store = new SessionStore((callSid) => ({
    session: newSession(callSid, 0, VOICE_RELAY, ANONYMOUS, app.id),
    opts: { client: placeClient(), thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, trace: new TraceWriter(join(dir, `${callSid}.jsonl`)) },
    trace: new TraceWriter(join(dir, `${callSid}.jsonl`)),
    frames: new FrameLog(join(dir, `${callSid}.frames.jsonl`), () => 0),
  }), 60_000, () => 0);
  const tokens = new CallTokens(60_000, () => 0);
  const sent: { type: string; token?: string }[] = [];
  const sock = { send: (d: string, cb?: (e?: Error) => void) => { sent.push(JSON.parse(d)); cb?.(); }, close: () => {} };
  const ctx = newConnectionContext(tokens.mint('CA5'));
  const frame = (m: object) => handleSocketMessage({ store, tokens, log: () => {} }, sock, ctx, JSON.stringify(m));
  await frame({ type: 'setup', sessionId: 'VX5', callSid: 'CA5', from: '+15555550100', to: '+15555550199', customParameters: {} });
  await frame({ type: 'prompt', voicePrompt: 'i want to report a problem', lang: 'en-US', last: true });
  await frame({ type: 'prompt', voicePrompt: place, lang: 'en-US', last: true });
  const wire = sent.filter((f) => f.type === 'text').map((f) => f.token!);
  const records = readFileSync(join(dir, 'CA5.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceRecord);
  const said = records.flatMap((r) => r.actions.flatMap((a) => (a.type === 'say' ? a.parts.flatMap((p) => ('text' in p ? [p.text] : [])) : [])));
  return { wire, said, session: store.get('CA5')!.session };
}

describe('voice.pronounce on the wire', () => {
  it('respells a word the caller gave, read back, on the wire only: the trace and the session keep it as written', async () => {
    const app = appWith('place-pronounce', { pronounce: { Alder: 'All-der' } });
    const { wire, said, session } = await readBack(app, '22 Alder Street');
    expect(wire.at(-1)).toBe('A problem at 22 All-der Street. Is that right?');
    expect(said.at(-1)).toBe('A problem at 22 Alder Street. Is that right?');
    expect(session.slots.place!.value).toBe('22 Alder Street');
    expect(session.lastPromptText).toContain('Alder Street');
  });

  it('matches whole words only', async () => {
    const app = appWith('place-pronounce-whole', { pronounce: { Alder: 'All-der' } });
    const { wire } = await readBack(app, '22 Alderman Street');
    expect(wire.at(-1)).toBe('A problem at 22 Alderman Street. Is that right?');
  });

  it("the locale's own list wins for that locale; the app's for any other", async () => {
    const app = appWith('place-pronounce-locale', { pronounce: { Alder: 'All-der' }, locales: { 'en-US': { pronounce: { Alder: 'Awl-dur' } } } });
    const { wire } = await readBack(app, '22 Alder Street');
    expect(wire.at(-1)).toBe('A problem at 22 Awl-dur Street. Is that right?');
  });

  it('without a list, the wire is as it was', async () => {
    const app = appWith('place-plain', undefined);
    const { wire, said } = await readBack(app, '22 Alder Street');
    expect(wire).toEqual(said);
  });
});

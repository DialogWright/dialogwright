import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveJevProvider } from './provider';
import { SdkJevClient } from './sdkClient';
import type { QuestionMap } from './types';

/**
 * A fake endpoint on this machine speaking the systemone contract, as an open-weight model that
 * mimics Jev would: it answers whatever it is asked with a choice (with probabilities), a noul and
 * a score, and keeps every request it saw. No request leaves the machine.
 */
interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: { model?: string; state?: unknown; questions?: Record<string, unknown> } | null;
}

const seen: Seen[] = [];
let server: Server;
let origin: string;

function bodyOf(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await bodyOf(req);
    const body = raw ? (JSON.parse(raw) as Seen['body']) : null;
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
    if (req.method !== 'POST' || !req.url?.endsWith('/v1/systemone')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body?.model,
      answers: {
        intent: { type: 'choice', choice: 'cancel', probabilities: { cancel: 0.8, none: 0.2 }, confidence: 0.8 },
        sure: { type: 'noul', noul: 0.12 },
        mood: { type: 'score', score: 0.3, probabilities: { 0: 0.7, 1: 0.3 }, confidence: 0.7 },
      },
      usage: { input_tokens: 64, output_tokens: 3 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const questions: QuestionMap = {
  intent: { type: 'choice', instructions: 'What does the caller want?', criteria: { cancel: 'to cancel', none: null } },
  sure: { type: 'noul', instructions: 'Is the caller unsure?' },
  mood: { type: 'score', instructions: 'How upset is the caller?', levels: [{ label: 'calm', description: 'calm' }, { label: 'upset', description: 'upset' }] },
};
const state = { asr: { text: 'cancel my appointment please', isFinal: true } };

function customClient(baseURL: string, extra: Record<string, string> = {}): SdkJevClient {
  const endpoint = resolveJevProvider({ JEV_PROVIDER: 'custom', JEV_BASE_URL: baseURL, JEV_MODEL: 'open-jev-7b', ...extra });
  return new SdkJevClient({ endpoint, timeoutMs: 2000, maxRetries: 0 });
}

describe('a client for a compatible endpoint', () => {
  it('posts to /v1/systemone with the Bearer key and the configured model, and reads the answers', async () => {
    seen.length = 0;
    const client = customClient(origin, { JEV_API_KEY: 'test-key' });
    const res = await client.ask({ state, questions });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/systemone', authorization: 'Bearer test-key' });
    expect(seen[0]!.body).toMatchObject({ model: 'open-jev-7b', state });
    expect(Object.keys(seen[0]!.body!.questions!)).toEqual(['intent', 'sure', 'mood']);
    expect(res.answers).toEqual({
      intent: { type: 'choice', choice: 'cancel', probabilities: { cancel: 0.8, none: 0.2 }, confidence: 0.8 },
      sure: { type: 'noul', noul: 0.12 },
      mood: { type: 'score', score: 0.3, probabilities: { calm: 0.7, upset: 0.3 }, confidence: 0.7 },
    });
    expect(res.model).toBe('open-jev-7b');
    expect(res.usage).toEqual({ inputTokens: 64, outputTokens: 3, estimated: false });
    expect(client.answeredBy).toEqual({ provider: 'custom', model: 'open-jev-7b', official: false });
  });

  it('appends /v1/systemone after a base URL\'s own path, as a gateway\'s is (Vercel\'s /typesafe)', async () => {
    seen.length = 0;
    await customClient(`${origin}/typesafe/`, { JEV_API_KEY: 'test-key' }).ask({ state, questions });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /typesafe/v1/systemone']);
  });

  it('sends no TypeSafe key to an endpoint that needs none, even with TYPESAFE_API_KEY set', async () => {
    seen.length = 0;
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'test-typesafe-key';
    try {
      await customClient(origin).ask({ state, questions });
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = saved;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization ?? '').not.toContain('test-typesafe-key');
  });

  it('warms with a HEAD to the base URL, and any HTTP answer, a 404 included, is fine', async () => {
    seen.length = 0;
    await expect(customClient(`${origin}/typesafe`).warm()).resolves.toBeUndefined();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['HEAD /typesafe']);
  });
});

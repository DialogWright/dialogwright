import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cassetteModel } from './cassette';
import { fakeModel } from './fake';
import { collect } from './testStream';
import type { ModelEvent, ModelRequest } from './types';

const req = (text: string): ModelRequest => ({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], maxTokens: 50 });
const turn = (t: string): ModelEvent[] => [{ type: 'text', delta: t }, { type: 'done', stop: 'end', usage: { inputTokens: 1, outputTokens: 1 } }];
const ctl = () => new AbortController().signal;
const path = () => join(mkdtempSync(join(tmpdir(), 'cassette-')), 'c.jsonl');

describe('cassetteModel', () => {
  it('records then replays identical events', async () => {
    const p = path();
    const live = await collect(cassetteModel({ path: p, inner: fakeModel([turn('hello')]) }).stream(req('a'), ctl()));
    const replay = await collect(cassetteModel({ path: p, inner: null }).stream(req('a'), ctl()));
    expect(replay).toEqual(live);
  });
  it('replays the same request asked twice as the first then the second answer', async () => {
    const p = path();
    const rec = cassetteModel({ path: p, inner: fakeModel([turn('one'), turn('two')]) });
    await collect(rec.stream(req('a'), ctl()));
    await collect(rec.stream(req('a'), ctl()));
    const replay = cassetteModel({ path: p, inner: null });
    expect(await collect(replay.stream(req('a'), ctl()))).toEqual(turn('one'));
    expect(await collect(replay.stream(req('a'), ctl()))).toEqual(turn('two'));
  });
  it('gives a cassette miss without an inner model', async () => {
    expect(await collect(cassetteModel({ path: path(), inner: null }).stream(req('a'), ctl()))).toEqual([{ type: 'error', kind: 'http', detail: 'cassette miss' }]);
  });
  it('keeps the recording model id, from the file or the option, so a replay can be priced', async () => {
    const p = path();
    const inner = { ...fakeModel([turn('x')]), id: 'inception:mercury-3' };
    await collect(cassetteModel({ path: p, inner }).stream(req('a'), ctl()));
    expect(cassetteModel({ path: p, inner: null }).id).toBe('inception:mercury-3');
    expect(cassetteModel({ path: path(), inner: null, id: 'anthropic:claude-haiku-5-5' }).id).toBe('anthropic:claude-haiku-5-5');
  });
  it('does not record a timeout or http failure, so the request is asked again', async () => {
    const p = path();
    const failing: ModelEvent[] = [{ type: 'error', kind: 'timeout', detail: 'slow' }];
    const rec = cassetteModel({ path: p, inner: fakeModel([failing, turn('ok')]) });
    expect(await collect(rec.stream(req('a'), ctl()))).toEqual(failing);
    expect(await collect(cassetteModel({ path: p, inner: null }).stream(req('a'), ctl()))).toEqual([{ type: 'error', kind: 'http', detail: 'cassette miss' }]);
    expect(await collect(rec.stream(req('a'), ctl()))).toEqual(turn('ok'));
    expect(await collect(cassetteModel({ path: p, inner: null }).stream(req('a'), ctl()))).toEqual(turn('ok'));
  });

  it('does not record the provider\'s rate limit (an HTTP 429), so the request is asked again', async () => {
    const p = path();
    const limited: ModelEvent[] = [{ type: 'error', kind: 'rate_limited', detail: 'HTTP 429', retryAfterMs: 1000 }];
    const rec = cassetteModel({ path: p, inner: fakeModel([limited, turn('ok')]) });
    expect(await collect(rec.stream(req('a'), ctl()))).toEqual(limited);
    expect(await collect(cassetteModel({ path: p, inner: null }).stream(req('a'), ctl()))).toEqual([{ type: 'error', kind: 'http', detail: 'cassette miss' }]);
    expect(await collect(rec.stream(req('a'), ctl()))).toEqual(turn('ok'));
    expect(await collect(cassetteModel({ path: p, inner: null }).stream(req('a'), ctl()))).toEqual(turn('ok'));
  });
});

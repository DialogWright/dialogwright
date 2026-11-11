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
});

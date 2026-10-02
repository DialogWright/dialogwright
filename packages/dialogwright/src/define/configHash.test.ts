import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { ANONYMOUS } from '../gate/principal';
import { VOICE_RELAY } from '../channel/caps';
import { speechEvent, startEvent, type SessionEvent } from '../channel/events';
import { AuditLog } from '../audit/log';
import type { AuditEntry } from '../audit/types';
import { verifyChain } from '../audit/verify';
import { combinedConfigHash, configHashLines, configHashesOf, contentHash, orderedJson } from '../core/app/configHash';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import { validateApp } from '../core/app/validate';
import { newSession, type Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { canonicalJson } from '../jev/cassette';
import { HeuristicStubClient } from '../jev/heuristicStub';
import type { AnswerMap, JevClient, JevRequest, JevResponse } from '../jev/types';
import { runTurn, type RunOptions } from '../run/turn';
import { choice, noul, score } from '../testing/answers';
import type { TraceRecord } from '../trace/types';
import { TraceWriter } from '../trace/writer';
import { configure, reduce } from '../server/dashboard/view.js';
import { consoleMetaOf } from '../server/dashboard/meta';
import { testkitApp } from '../testing/testkit';
import { defineApp } from './defineApp';
import { libraryApp, libraryCode, LIBRARY_DIR } from './fixture/app';
import { loadAppFolder } from './load';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A copy of the library's folder (its YAML only), with `edit` applied to each named file's text. */
function folder(edits: Record<string, (text: string) => string> = {}): string {
  const dir = tempDir('dialogwright-hash-');
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, edit] of Object.entries(edits)) writeFileSync(join(dir, file), edit(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

function hashesOf(dir: string): App['configHashes'] & object {
  const loaded = loadAppFolder(dir);
  expect(loaded.problems).toEqual([]);
  return loaded.config!.hashes;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const LIBRARY_FILES = ['app.yaml', 'forms.yaml', 'intents.yaml', 'locale/es/prompts.yaml', 'locale/es/slots.yaml', 'policy.yaml', 'prompts.yaml'];

describe('configuration hashes: the arithmetic', () => {
  it('hashes a value as JSON: keys in document order at every level, arrays in order, no whitespace', () => {
    expect(contentHash({ b: 1, a: [2, 1], c: { z: 'x', y: null } })).toBe(sha256('{"b":1,"a":[2,1],"c":{"z":"x","y":null}}'));
    expect(orderedJson({ a: undefined, b: [{ y: 1, x: 2 }] })).toBe('{"b":[{"y":1,"x":2}]}');
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
    expect(contentHash({ n: 1 })).not.toBe(contentHash({ n: '1' }));
  });

  it('is order-preserving: the same keys in another order are another hash, at every level (a key\'s place is meaning, as in slots.yaml)', () => {
    expect(contentHash({ a: 1, b: 2 })).not.toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ k: { a: 1, b: 2 } })).not.toBe(contentHash({ k: { b: 2, a: 1 } }));
    expect(contentHash([{ a: 1, b: 2 }])).not.toBe(contentHash([{ b: 2, a: 1 }]));
    // while the cassette's key still sorts: that is a different job (jev/cassette.ts)
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('combines the files\' `<file>:<hash>` lines, sorted by file and joined by newlines', () => {
    const files = { 'policy.yaml': 'b'.repeat(64), 'app.yaml': 'a'.repeat(64) };
    expect(configHashLines(files)).toEqual([`app.yaml:${'a'.repeat(64)}`, `policy.yaml:${'b'.repeat(64)}`]);
    expect(combinedConfigHash(files)).toBe(sha256(`app.yaml:${'a'.repeat(64)}\npolicy.yaml:${'b'.repeat(64)}`));
    const hashes = configHashesOf({ 'policy.yaml': { maxAttempts: 3 }, 'app.yaml': { id: 'x' } });
    expect(Object.keys(hashes.files)).toEqual(['app.yaml', 'policy.yaml']);
    expect(hashes.files['app.yaml']).toBe(contentHash({ id: 'x' }));
    expect(hashes.app).toBe(combinedConfigHash(hashes.files));
  });
});

describe('configuration hashes: the loader', () => {
  const base = hashesOf(LIBRARY_DIR);

  it('hashes every file it reads, each locale\'s prompts as an entry of its own, and the whole', () => {
    expect(Object.keys(base.files)).toEqual(LIBRARY_FILES);
    for (const hash of [base.app, ...Object.values(base.files)]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(base.files['policy.yaml']).toBe(contentHash(parse(readFileSync(join(LIBRARY_DIR, 'policy.yaml'), 'utf8'))));
    expect(base.app).toBe(combinedConfigHash(base.files));
    // identity.yaml, when there is one, is hashed too (the valid loader fixture has one, and locale/fr)
    expect(Object.keys(hashesOf(join(__dirname, '__fixtures__', 'valid')).files)).toEqual([
      'app.yaml', 'forms.yaml', 'identity.yaml', 'intents.yaml', 'locale/fr/prompts.yaml', 'policy.yaml', 'prompts.yaml',
    ]);
  });

  it('does not change for comments, whitespace, flow or block style or quoting style', () => {
    const hand = hashesOf(folder({
      'policy.yaml': (t) => `# the library's policy\n\n${t
        .replace('maxAttempts: 3', 'maxAttempts:    3   # three tries')
        .replace('confirmedFields: [book]', 'confirmedFields: [ "book" ]   ')
        .replace('renewLoan: [R1, R3]', "renewLoan:\n    - 'R1'\n    - R3")}\n\n# end\n`,
    }));
    expect(hand).toEqual(base);
    // The same content written out again in another style altogether: flow collections, every
    // string double-quoted, and no comments; the keys keep their order.
    const restyled = (t: string): string => stringify(parse(t), { collectionStyle: 'flow', defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
    const other = folder({ 'policy.yaml': restyled, 'intents.yaml': restyled, 'prompts.yaml': restyled, 'locale/es/prompts.yaml': restyled });
    expect(readFileSync(join(other, 'policy.yaml'), 'utf8')).not.toBe(readFileSync(join(LIBRARY_DIR, 'policy.yaml'), 'utf8'));
    expect(hashesOf(other)).toEqual(base);
  });

  it('changes the file\'s hash and the whole\'s, and no other file\'s, when its keys are reordered: key order is meaning', () => {
    const reversed = (t: string): string => stringify(parse(t), { sortMapEntries: (a, b) => String(b.key).localeCompare(String(a.key)) });
    const reordered = hashesOf(folder({ 'policy.yaml': reversed }));
    expect(reordered.files['policy.yaml']).not.toBe(base.files['policy.yaml']);
    expect(reordered.app).not.toBe(base.app);
    for (const file of LIBRARY_FILES.filter((f) => f !== 'policy.yaml')) expect(reordered.files[file], file).toBe(base.files[file]);
  });

  it('changes the file\'s hash and the whole\'s, and no other file\'s, when a value changes', () => {
    const changed = hashesOf(folder({ 'policy.yaml': (t) => t.replace('maxAttempts: 3', 'maxAttempts: 4') }));
    expect(changed.files['policy.yaml']).not.toBe(base.files['policy.yaml']);
    expect(changed.app).not.toBe(base.app);
    for (const file of LIBRARY_FILES.filter((f) => f !== 'policy.yaml')) expect(changed.files[file], file).toBe(base.files[file]);
  });

  it('changes a locale\'s entry, and the whole, when that locale\'s prompts change', () => {
    const es = hashesOf(folder({ 'locale/es/prompts.yaml': (t) => t.replace('Gracias por llamar', 'Gracias por su llamada') }));
    expect(es.files['locale/es/prompts.yaml']).not.toBe(base.files['locale/es/prompts.yaml']);
    expect(es.files['prompts.yaml']).toBe(base.files['prompts.yaml']);
    expect(es.app).not.toBe(base.app);
  });

  it('changes the whole when a file is added or removed', () => {
    const dir = folder();
    rmSync(join(dir, 'locale'), { recursive: true });
    const fewer = hashesOf(dir);
    expect(Object.keys(fewer.files)).toEqual(LIBRARY_FILES.filter((f) => !f.startsWith('locale/')));
    expect(fewer.app).not.toBe(base.app);
  });
});

describe('configuration hashes: defineApp and validateApp', () => {
  it('puts the folder\'s hashes on the App, and validateApp accepts them', () => {
    expect(libraryApp.configHashes).toEqual(hashesOf(LIBRARY_DIR));
    expect(() => validateApp(libraryApp)).not.toThrow();
    // A second build of the same folder has the same hashes.
    expect(defineApp(LIBRARY_DIR, libraryCode).configHashes).toEqual(libraryApp.configHashes);
  });

  it('validateApp refuses hashes of the wrong shape, or a combined hash that is not its files\'', () => {
    const h = libraryApp.configHashes!;
    const bad = (configHashes: unknown): (() => void) => () => validateApp({ ...libraryApp, configHashes } as App);
    expect(bad({ app: h.app, files: {} })).toThrow(/configHashes has no files/);
    expect(bad({ app: h.app })).toThrow(/configHashes has no files/);
    expect(bad({ ...h, files: { ...h.files, 'policy.yaml': 'not-a-hash' } })).toThrow(/configHashes file "policy.yaml" has no SHA-256 hash/);
    expect(bad({ ...h, files: { ...h.files, 'a:b.yaml': h.app } })).toThrow(/configHashes file "a:b.yaml" is not a file path/);
    expect(bad({ ...h, app: h.app.toUpperCase() })).toThrow(/no combined SHA-256 hash/);
    expect(bad({ ...h, app: '0'.repeat(64) })).toThrow(/combined hash is not the hash of its files' hashes/);
  });
});

/** A model that answers each turn from a script: the library's base answers, the turn's own over them, and a low noul to any other yes-or-no it is asked (the injection screen's). */
class ScriptedClient implements JevClient {
  /** Each request's state, as sent. */
  readonly sent: string[] = [];
  constructor(private readonly turns: AnswerMap[]) {}
  async ask(req: JevRequest): Promise<JevResponse> {
    this.sent.push(JSON.stringify(req.state));
    const given: AnswerMap = {
      addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
      rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
      frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }), intent: choice({ none: 0.9, other: 0.1 }),
      ...(this.turns.shift() ?? {}),
    };
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (Object.hasOwn(given, id)) answers[id] = given[id]!;
      else if (q.type === 'noul') answers[id] = noul(0.02);
    }
    return { answers, model: 'scripted', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 0, source: 'stub:fixture' };
  }
}

/** One call, its audit chained to a day file and its trace written to a file, as the server writes them. */
async function call(session: Session, client: JevClient, events: SessionEvent[]): Promise<{ audit: AuditEntry[]; auditPath: string; trace: TraceRecord[]; traceText: string }> {
  const dir = tempDir('dialogwright-hash-call-');
  const log = new AuditLog(join(dir, 'audit'), () => Date.parse('2026-09-18T12:00:00.000Z'));
  const tracePath = join(dir, 'trace.jsonl');
  const opts: RunOptions = {
    client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0,
    trace: new TraceWriter(tracePath), audit: log,
  };
  let s = session;
  for (const event of events) s = (await runTurn(s, event, opts)).result.session;
  const auditText = readFileSync(log.path, 'utf8');
  const traceText = readFileSync(tracePath, 'utf8');
  const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
  return { audit: lines(auditText) as AuditEntry[], auditPath: log.path, trace: lines(traceText) as TraceRecord[], traceText };
}

describe('configuration hashes: a call', () => {
  registerApp(libraryApp);

  it('records them once, in call_started, and the combined hash on every trace record; the chain verifies; the model never sees them', async () => {
    const hashes = libraryApp.configHashes!;
    const client = new ScriptedClient([{ intent: choice({ renew_loan: 0.95, none: 0.05 }) }]);
    const session = newSession('library-hashes', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id);
    const { audit, auditPath, trace } = await call(session, client, [startEvent(), speechEvent('I want to renew a book')]);

    const started = audit.filter((e) => e.type === 'call_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.detail).toEqual({
      channel: 'voice', principal: 'anonymous', level: 0,
      config: hashes.app,
      configFiles: LIBRARY_FILES.map((f) => `${f}:${hashes.files[f]}`),
    });
    // The row alone is enough to check the combined hash against its files.
    const lines = started[0]!.detail.configFiles as string[];
    expect(sha256(lines.join('\n'))).toBe(started[0]!.detail.config);
    // Once per call: no other row names the configuration.
    for (const e of audit.filter((e) => e.type !== 'call_started')) expect(Object.keys(e.detail)).not.toContain('config');
    expect(verifyChain(auditPath)).toEqual({ ok: true, entries: audit.length });

    expect(trace).toHaveLength(2);
    for (const r of trace) expect(r.configHash).toBe(hashes.app);
    expect(trace[1]!.form).toBe('renew_loan');
    // The full list is in the trace once too, in the first record's audit drafts.
    expect(trace[0]!.audit?.find((d) => d.type === 'call_started')?.detail.configFiles).toEqual(lines);

    // The model's request carries none of it: a hash is not part of what perception reads.
    expect(client.sent).toHaveLength(1);
    for (const state of client.sent) {
      expect(state).not.toContain(hashes.app);
      for (const hash of Object.values(hashes.files)) expect(state).not.toContain(hash);
      expect(state).not.toMatch(/config/i);
    }
  });

  it('an app without hashes (the testkit) records exactly what it did before: no config in call_started, no configHash on a record', async () => {
    const { audit, auditPath, trace, traceText } = await call(newSession('testkit-hashes', 0, VOICE_RELAY), new HeuristicStubClient({ todayIso: '2026-09-18' }), [startEvent(), speechEvent('hello')]);
    const started = audit.find((e) => e.type === 'call_started')!;
    expect(Object.keys(started.detail)).toEqual(['channel', 'principal', 'level']);
    expect(verifyChain(auditPath).ok).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
    for (const r of trace) expect(Object.hasOwn(r, 'configHash')).toBe(false);
    expect(traceText).not.toContain('configHash');
  });

  it('the console shows the call\'s combined hash for an app with hashes, and none for an app without', async () => {
    const started = { type: 'call_started' as const, callSid: 'CA1', at: 0, from: '…0100', todayIso: '2026-09-18', thresholds: {}, channel: 'voice' };
    const turns = (trace: TraceRecord[]) => trace.map((record, i) => ({ type: 'turn' as const, callSid: 'CA1', at: i + 1, record, spoken: '' }));
    configure(consoleMetaOf(libraryApp));
    const library = await call(newSession('library-console', 0, VOICE_RELAY, ANONYMOUS, libraryApp.id), new ScriptedClient([]), [startEvent()]);
    expect(reduce([started, ...turns(library.trace)]).configHash).toBe(libraryApp.configHashes!.app);
    // a second call starts without the first call's hash
    expect(reduce([started, ...turns(library.trace), started])).not.toHaveProperty('configHash');
    configure(consoleMetaOf(testkitApp));
    const kit = await call(newSession('testkit-console', 0, VOICE_RELAY), new HeuristicStubClient({ todayIso: '2026-09-18' }), [startEvent()]);
    expect(reduce([started, ...turns(kit.trace)])).not.toHaveProperty('configHash');
  });
});

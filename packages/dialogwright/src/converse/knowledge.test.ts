import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkApp } from '../define/check';
import type { AnswerMap, JevClient, JevRequest } from '../jev/types';
import { collectGaps, turnsOfLines } from '../kb/gaps';
import { defaultRetriever } from '../kb/hybrid';
import type { KbPassage, KnowledgeBase } from '../kb/types';
import { converseCall } from '../server/dashboard/view.js';
import { CONVERSE_FIXTURE_DIR } from '../testing/converse/app';
import { conversePolicyCardText, conversePolicyMatrixText } from '../testing/conversePages';
import { converseTestCall } from '../testing/converseCall';
import { judgeInput, type AuditedAction } from '../eval/judge';
import { defineConverseApp, type ConverseApp } from './app';
import { LOOK_UP, UNANSWERED_QUESTION } from './business/schema';
import { converseFacts } from '../server/dashboard/figures';
import { hasApprovedAnswer, LOOK_UP_AT, LOOK_UP_QUESTION_ID, lookUp, NOT_FOUND, WORDING_AS_WRITTEN, WORDING_LOW, type ConverseKnowledge } from './knowledge';
import { fakeModel } from './model/fake';
import type { ModelEvent } from './model/types';
import { systemPrompt } from './prompt';
import { newConverseState } from './state';

/**
 * The knowledge base in agent mode (the maintainer's decision, 2026-11-27): an agent app's kb/ read as a scripted app's
 * is, the runtime's own look_up offered where an approved passage is there to be found, the decision model reading which
 * nominated topic the caller asks about, and only a fresh approved passage returned, with its wording rule.
 */

const TODAY = '2026-11-27';
const NOW = new Date(`${TODAY}T15:00:00Z`);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KB_YAML = '# yaml-language-server: $schema=../../schemas/kb-settings.schema.json\naction: look_up\n';
const TOPICS = `# yaml-language-server: $schema=../../schemas/kb-topics.schema.json
care:
  title: Caring for a mended item
  keywords: [care, clean, cleaning]
  asks: [How do I look after it once it is mended?]
  risk: low
returns:
  title: Returning a mended item
  keywords: [return, refund, returning]
  asks: [Can I bring it back if it breaks again?]
`;
const SOURCE = `# yaml-language-server: $schema=../../../schemas/kb-source.schema.json
document: Example Visits notes
sections:
  care:
    text: Wipe a mended item with a dry cloth, and keep it out of water for a day.
  returns:
    text: Bring a mended item back within 30 days if the mend fails, and we look at it again.
`;
const passage = (id: string, topic: string, section: string, answer: string): string => `# yaml-language-server: $schema=../../../schemas/kb-passage.schema.json
id: ${id}
topic: ${topic}
version: "2026.1"
effective: { from: 2026-01-01 }
source: { document: notes, section: ${section} }
answer: ${JSON.stringify(answer)}
`;

/** An agent app's folder: the converse fixture's app.yaml and agent.yaml, with a kb/ whose passages are unapproved (`edit` changes a file's text). */
function folder(edit: Record<string, (t: string) => string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 'converse-kb-'));
  dirs.push(d);
  for (const f of ['app.yaml', 'agent.yaml']) copyFileSync(join(CONVERSE_FIXTURE_DIR, f), join(d, f));
  mkdirSync(join(d, 'kb', 'passages'), { recursive: true });
  mkdirSync(join(d, 'kb', 'sources'), { recursive: true });
  const files: Record<string, string> = {
    'kb/kb.yaml': KB_YAML,
    'kb/topics.yaml': TOPICS,
    'kb/sources/notes.yaml': SOURCE,
    'kb/passages/care-1.yaml': passage('care-1', 'care', 'care', 'Wipe a mended item with a dry cloth, and keep it out of water for a day.'),
    'kb/passages/returns-1.yaml': passage('returns-1', 'returns', 'returns', 'Bring a mended item back within 30 days if the mend fails, and we look at it again.'),
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), (edit[f] ?? ((t) => t))(text));
  // The schema lines' paths, from the temporary folder: relative to the fixture's own (they only help an editor).
  return d;
}

const tools = { availability: async () => [], book: async () => 'booked' };

/** The app of a folder, its passages as read (unapproved), or with those `approved` marked fresh in memory (never written). */
function appOf(dir: string, approved: readonly string[] = []): ConverseApp {
  const app = defineConverseApp(dir, { tools });
  const k = app.knowledge!;
  const passages: Record<string, KbPassage> = {};
  for (const [id, p] of Object.entries(k.kb.passages)) {
    passages[id] = approved.includes(id) ? { ...p, approval: { owner: 'test', approvedBy: 'a test double', on: TODAY, sourceHash: p.current.sourceHash ?? '', hash: p.current.hash }, freshness: 'fresh' } : p;
  }
  const kb: KnowledgeBase = { ...k.kb, passages };
  return { ...app, knowledge: { kb, retriever: defaultRetriever(kb).retriever } };
}

/** A decision model that reads the lookup's question as `choice` at `p` (the check after speaking's questions at 0), keeping what it was asked. */
function jevReading(choice: string, p: number): JevClient & { asked: JevRequest[] } {
  const asked: JevRequest[] = [];
  return {
    asked,
    async ask(req) {
      asked.push(req);
      const answers: AnswerMap = {};
      for (const id of Object.keys(req.questions)) {
        answers[id] = id === LOOK_UP_QUESTION_ID ? { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } } : { type: 'noul', noul: 0 };
      }
      return { answers, model: 'fake', usage: { inputTokens: 0, outputTokens: 0, estimated: true }, latencyMs: 1, source: 'jev' };
    },
  };
}

const text = (delta: string): ModelEvent => ({ type: 'text', delta });
const call = (id: string, name: string, args: Record<string, unknown>): ModelEvent => ({ type: 'tool_call', id, name, args });
const done = (stop: 'end' | 'tool' = 'end'): ModelEvent => ({ type: 'done', stop, usage: { inputTokens: 10, outputTokens: 5 } });

describe('an agent app\'s knowledge base folder', () => {
  it('is read with the app, and with no passage approved the lookup is offered nowhere', async () => {
    const app = defineConverseApp(folder(), { tools });
    expect(Object.keys(app.knowledge!.kb.topics)).toEqual(['care', 'returns']);
    expect(Object.values(app.knowledge!.kb.passages).map((p) => p.freshness)).toEqual(['unapproved', 'unapproved']);
    expect(hasApprovedAnswer(app.knowledge, TODAY)).toBe(false);
    const model = fakeModel([[text('Hello.'), done()]]);
    const c = converseTestCall(app, { model, jev: jevReading('none', 1), now: () => NOW });
    await c.start();
    await c.say('How do I look after it?');
    const offered = (model as unknown as { requests: { tools?: { name: string }[] }[] }).requests.at(-1)!.tools!.map((t) => t.name);
    expect(offered).not.toContain(LOOK_UP);
  });

  it('an app with no kb/ has no knowledge base, and its gate no lookup', () => {
    const d = folder();
    rmSync(join(d, 'kb'), { recursive: true });
    const app = defineConverseApp(d, { tools });
    expect(app.knowledge).toBeUndefined();
    expect(conversePolicyMatrixText(app)).not.toContain(LOOK_UP);
  });

  it('pnpm check refuses answers from documents, another action, and holds an unapproved passage as a scripted app does', async () => {
    const lines = async (d: string): Promise<string[]> => (await checkApp(d, { todayIso: TODAY })).map((p) => `${p.file} ${p.path} ${p.message}`);
    expect(await lines(folder({ 'kb/kb.yaml': (t) => `${t}documents: { summarize: on }\n` }))).toEqual([expect.stringMatching(/^kb\/kb\.yaml documents\.summarize answers from approved documents \(documents\.summarize: on\) are not yet supported in agent mode$/)]);
    expect(await lines(folder({ 'kb/kb.yaml': (t) => t.replace('look_up', 'findPassage') }))).toEqual(['kb/kb.yaml action an agent app\'s knowledge base is read through the runtime\'s own lookup, "look_up", and kb.yaml names "findPassage"']);
    expect(await lines(folder())).toEqual([
      'kb/passages/care-1.yaml answer passage "care-1" is not approved, so it is never said',
      'kb/passages/returns-1.yaml answer passage "returns-1" is not approved, so it is never said',
    ]);
    // With nothing but proposals (no topic, no passage), the folder passes.
    const d = folder({ 'kb/topics.yaml': () => '# yaml-language-server: $schema=../../schemas/kb-topics.schema.json\n{}\n' });
    rmSync(join(d, 'kb', 'passages'), { recursive: true });
    expect(await lines(d)).toEqual([]);
  });

  it('defineConverseApp refuses what agent mode does not support, as check does', () => {
    expect(() => defineConverseApp(folder({ 'kb/kb.yaml': (t) => `${t}documents: { summarize: on }\n` }), { tools })).toThrow(/not yet supported in agent mode/);
  });
});

describe('the lookup', () => {
  const k = (approved: readonly string[]): ConverseKnowledge => appOf(folder(), approved).knowledge!;

  it('returns the approved passage a question asks about, with its topic\'s wording rule (risk: low and not)', async () => {
    const knowledge = k(['care-1', 'returns-1']);
    const low = await lookUp(knowledge, jevReading('care', 0.9), 'How should I care for it after cleaning?', '<40 chars>', TODAY, 1000);
    expect(JSON.parse(low.content)).toEqual({ topic: 'Caring for a mended item', answer: 'Wipe a mended item with a dry cloth, and keep it out of water for a day.', wording: WORDING_LOW });
    expect(low.record).toMatchObject({ question: '<40 chars>', outcome: 'answered', topic: 'care', title: 'Caring for a mended item', passage: { id: 'care-1' }, reading: { choice: 'care', p: 0.9 } });
    expect(low.record.passage!.approvalHash).toMatch(/^[0-9a-f]{12}$/);
    expect(low.audit).toEqual([expect.objectContaining({ type: 'kb_answer', detail: expect.objectContaining({ passageId: 'care-1', fresh: true }) })]);
    const asWritten = await lookUp(knowledge, jevReading('returns', 0.9), 'Can I return it for a refund?', '•', TODAY, 1000);
    expect(JSON.parse(asWritten.content)).toEqual({ topic: 'Returning a mended item', answer: 'Bring a mended item back within 30 days if the mend fails, and we look at it again.', wording: WORDING_AS_WRITTEN });
  });

  it('a question nothing is nominated for, or that none of the candidates answers, finds no approved answer', async () => {
    const knowledge = k(['care-1']);
    const nothing = await lookUp(knowledge, jevReading('care', 0.9), 'Do you take cards?', '•', TODAY, 1000);
    expect(nothing.record).toMatchObject({ outcome: 'none', candidates: [] });
    expect(nothing.record.reading).toBeUndefined();
    expect(JSON.parse(nothing.content)).toEqual({ answer: null, found: NOT_FOUND });
    const unanswered = await lookUp(knowledge, jevReading('unanswered', 0.9), 'Do you clean carpets?', '•', TODAY, 1000);
    expect(unanswered.record).toMatchObject({ outcome: 'none', reading: { choice: 'unanswered' } });
    expect(JSON.parse(unanswered.content).answer).toBeNull();
  });

  it('a reading below the bar finds no approved answer', async () => {
    const r = await lookUp(k(['care-1']), jevReading('care', LOOK_UP_AT - 0.01), 'How do I clean it?', '•', TODAY, 1000);
    expect(r.record).toMatchObject({ outcome: 'none', reading: { choice: 'care' } });
    expect(JSON.parse(r.content)).toEqual({ answer: null, found: NOT_FOUND });
  });

  it('never returns a passage that is not approved, stale or edited: it is withheld', async () => {
    const knowledge = k(['care-1']);
    const unapproved = await lookUp(knowledge, jevReading('returns', 0.9), 'Can I return it?', '•', TODAY, 1000);
    expect(unapproved.record).toMatchObject({ outcome: 'withheld', topic: 'returns', withheld: { why: 'stale', id: 'returns-1' } });
    expect(unapproved.content).not.toContain('30 days');
    expect(unapproved.audit).toEqual([expect.objectContaining({ type: 'kb_answer', detail: expect.objectContaining({ passageId: 'returns-1', fresh: false }) })]);
    for (const freshness of ['source-changed', 'edited'] as const) {
      const kb = { ...knowledge.kb, passages: { ...knowledge.kb.passages, 'care-1': { ...knowledge.kb.passages['care-1']!, freshness } } };
      const r = await lookUp({ kb, retriever: knowledge.retriever }, jevReading('care', 0.9), 'How do I clean it?', '•', TODAY, 1000);
      expect(r.record.outcome).toBe('withheld');
      expect(r.content).not.toContain('dry cloth');
    }
  });
});

describe('the lookup on a call', () => {
  it('goes through the gate and into the audit and the trace, its question recorded by its length by default', async () => {
    const app = appOf(folder(), ['care-1']);
    const question = 'How do I look after it once it is mended?';
    const model = fakeModel([
      [call('k1', LOOK_UP, { question }), done('tool')],
      [text('Wipe it with a dry cloth and keep it dry for a day.'), done()],
    ]);
    const c = converseTestCall(app, { model, jev: jevReading('care', 0.9), now: () => NOW });
    await c.start();
    const said = await c.say(question);
    expect(said.join(' ')).toContain('dry cloth');
    const gate = c.audit.find((r) => r.type === 'gate' && r.detail.tool === LOOK_UP)!;
    expect(gate.detail).toMatchObject({ verdict: 'ALLOW', call: `look_up(question=<${question.length} chars>)` });
    expect(JSON.stringify(c.audit)).not.toContain(question);
    expect(c.audit.find((r) => r.type === 'tool_result' && r.detail.tool === LOOK_UP)!.detail.summary).toContain('dry cloth');
    expect(c.audit.some((r) => r.type === 'kb_answer' && r.detail.passageId === 'care-1')).toBe(true);
    const turn = c.traces.at(-1)!;
    expect(turn.tools).toEqual([{ name: LOOK_UP, args: { question: `<${question.length} chars>` }, outcome: 'ran' }]);
    expect(turn.lookUps).toEqual([expect.objectContaining({ question: `<${question.length} chars>`, outcome: 'answered', topic: 'care', passage: expect.objectContaining({ id: 'care-1' }) })]);
    // The model was sent the passage as the lookup's result.
    const requests = (model as unknown as { requests: { messages: unknown[]; system: string }[] }).requests;
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(WORDING_LOW.slice(0, 30));
    expect(requests.at(-1)!.system).toContain(`${LOOK_UP} finds the one for a question`);
    // The console's call view says it in one line.
    expect(converseCall(c.traces).turns.at(-1)!.lookUps).toEqual(['looked up: Caring for a mended item']);
  });

  it('agent.yaml knowledge.audit keeps the question where it says so, and knowledge.journeys is checked against the journeys', async () => {
    const d = folder();
    writeFileSync(join(d, 'agent.yaml'), `${(await import('node:fs')).readFileSync(join(d, 'agent.yaml'), 'utf8')}knowledge:\n  audit: { question: keep }\n`);
    const app = appOf(d, ['care-1']);
    const model = fakeModel([[call('k1', LOOK_UP, { question: 'How do I clean it?' }), done('tool')], [text('A dry cloth.'), done()]]);
    const c = converseTestCall(app, { model, jev: jevReading('care', 0.9), now: () => NOW });
    await c.start();
    await c.say('How do I clean it?');
    expect(c.traces.at(-1)!.tools[0]!.args).toEqual({ question: 'How do I clean it?' });
    writeFileSync(join(d, 'agent.yaml'), `${(await import('node:fs')).readFileSync(join(d, 'agent.yaml'), 'utf8')}`.replace('knowledge:\n  audit: { question: keep }\n', 'knowledge:\n  journeys: [request]\n'));
    expect(await checkApp(d, { todayIso: TODAY })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'knowledge.journeys', message: 'knowledge.journeys names journeys, and the business has none' })]));
  });

  it('a note of a question the passage found does not answer carries what the turn\'s lookups found, and takes no third round', async () => {
    const app = appOf(folder(), ['care-1']);
    const question = 'How should I clean it, is steam all right?';
    const noted = 'Whether a steam cleaner is all right on a mended item';
    const model = fakeModel([
      [call('k1', LOOK_UP, { question }), done('tool')],
      [text('Our care notes say a dry cloth, and say nothing of steam, so I would not want to guess.'), call('g1', UNANSWERED_QUESTION, { question: noted }), done('tool')],
    ]);
    const c = converseTestCall(app, { model, jev: jevReading('care', 0.9), now: () => NOW });
    await c.start();
    await c.say(question);
    expect((model as unknown as { requests: unknown[] }).requests).toHaveLength(2);
    expect(c.traces.at(-1)!.gapNotes).toEqual([{ question: `<${noted.length} chars>`, lookUps: [{ outcome: 'answered', topic: 'care' }] }]);
    expect(c.audit.find((r) => r.type === 'converse_gap_note')!.detail).toEqual({ question: `<${noted.length} chars>`, lookUps: ['answered: care'] });
    // The console's call view says it on the turn, with the question as recorded.
    expect(converseCall(c.traces).turns.at(-1)!.gapNotes).toEqual([`noted a gap: <${noted.length} chars>`]);
  });

  it('called where it is not offered (nothing approved), it is refused as not offered', async () => {
    const app = appOf(folder());
    const model = fakeModel([[call('k1', LOOK_UP, { question: 'How do I clean it?' }), done('tool')], [text('I cannot say.'), done()]]);
    const c = converseTestCall(app, { model, jev: jevReading('care', 0.9), now: () => NOW });
    await c.start();
    await c.say('How do I clean it?');
    expect(c.traces.at(-1)!.tools[0]).toMatchObject({ name: LOOK_UP, outcome: 'refused' });
    expect(c.audit.some((r) => r.type === 'converse_refused' && r.detail.action === LOOK_UP && r.detail.reason === 'not-offered')).toBe(true);
  });
});

describe('what the lookup adds around it', () => {
  it('the business information says the approved answers are found with the lookup only where it is offered', () => {
    const app = appOf(folder(), ['care-1']);
    const s = newConverseState({ appId: 'converse', callId: 'c', channel: 'chat' });
    expect(systemPrompt(app.business, s, NOW, undefined, true)).toContain(`the business has approved answers to further questions callers ask: ${LOOK_UP} finds the one for a question`);
    expect(systemPrompt(app.business, s, NOW, undefined, true)).toContain('When the caller says back what an answer said, or asks you to confirm their reading of it, compare their version with the answer\'s own words: where it matches, agree; where it differs from the answer or goes beyond it, tell them what the answer does say, as a helpful person would.');
    expect(systemPrompt(app.business, s, NOW)).not.toContain(LOOK_UP);
    expect(systemPrompt(app.business, s, NOW)).not.toContain('says back what an answer said');
  });

  it('the policy card lists the knowledge base, its wording rule as instruction only, and which topics are which; the matrix the lookup', () => {
    const app = appOf(folder());
    const card = conversePolicyCardText(app);
    expect(card).toContain('## Knowledge base');
    expect(card).toContain('by the agent model\'s instructions only: this is not enforced');
    expect(card).toContain('| `care` | Caring for a mended item | worded for the caller\'s question (`risk: low`) |');
    expect(card).toContain('| `returns` | Returning a mended item | as written (by instruction only) |');
    expect(conversePolicyMatrixText(app)).toContain(`${LOOK_UP} · level 0 · no rules\n  every caller  ALLOW`);
  });

  it('the policy pages list unanswered_question with the runtime\'s own actions, saying how its question is recorded; off, that it is off', async () => {
    const app = appOf(folder());
    const card = conversePolicyCardText(app);
    expect(card).toContain(`- \`${UNANSWERED_QUESTION}\` is the runtime's own action, offered to the agent model on every turn`);
    expect(card).toContain('is recorded by its length only (`gaps.audit`)');
    expect(conversePolicyMatrixText(app)).toContain(`${UNANSWERED_QUESTION} · level 0 · no rules\n  every caller  ALLOW`);
    const d = folder();
    writeFileSync(join(d, 'agent.yaml'), `${(await import('node:fs')).readFileSync(join(d, 'agent.yaml'), 'utf8')}gaps:\n  note: off\n`);
    const off = appOf(d);
    expect(conversePolicyCardText(off)).toContain(`- \`${UNANSWERED_QUESTION}\`, the runtime's note of a question the business could not answer, is off (\`gaps.note\`: off)`);
    expect(conversePolicyMatrixText(off)).not.toContain(UNANSWERED_QUESTION);
  });

  it('kb:gaps reads a lookup that found no approved answer from an agent app\'s trace', () => {
    const record = { v: 3, kind: 'converse', sessionId: 'c-1', turnIndex: 1, ts: `${TODAY}T15:00:00.000Z`, said: 'Do you clean carpets?', replies: [], tools: [], model: { id: 'm', ms: 0, firstTextMs: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null },
      lookUps: [
        { question: '<21 chars>', retriever: 'keyword', candidates: [{ topic: 'care', score: 1 }], reading: { choice: 'unanswered', p: 0.9 }, outcome: 'none', ms: 3 },
        { question: '<10 chars>', retriever: 'keyword', candidates: [{ topic: 'care', score: 1 }], outcome: 'answered', topic: 'care', title: 'Caring', passage: { id: 'care-1' }, ms: 3 },
        { question: '<10 chars>', retriever: 'keyword', candidates: [{ topic: 'returns', score: 1 }], outcome: 'withheld', topic: 'returns', withheld: { why: 'stale', id: 'returns-1' }, ms: 3 },
      ] };
    const { turns } = turnsOfLines([JSON.stringify(record)], 'trace.jsonl');
    const { gaps } = collectGaps(turns, { topicSlots: new Set(), informational: new Set(), nearest: () => null });
    expect(gaps).toEqual([
      expect.objectContaining({ kind: 'none', topic: 'care', words: 'Do you clean carpets?', sessionId: 'c-1' }),
      expect.objectContaining({ kind: 'unavailable', topic: 'returns', reason: 'stale', passage: { id: 'returns-1', document: null, section: null } }),
    ]);
  });

  it('kb:gaps reads a gap note as a gap, by the topic the turn\'s lookup found, its note where kept and the caller\'s words; the turn\'s unanswered lookup is not counted again, a withheld passage is', () => {
    const base = { v: 3, kind: 'converse', ts: `${TODAY}T15:00:00.000Z`, replies: [], tools: [], model: { id: 'm', ms: 0, firstTextMs: null, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: null } };
    const records = [
      { ...base, sessionId: 'c-1', turnIndex: 1, said: 'Is steam all right on it?', lookUps: [{ question: '<25 chars>', retriever: 'keyword', candidates: [{ topic: 'care', score: 1 }], outcome: 'answered', topic: 'care', title: 'Caring', passage: { id: 'care-1' }, ms: 3 }],
        gapNotes: [{ question: 'Whether steam cleaning is all right on a mended item', lookUps: [{ outcome: 'answered', topic: 'care' }] }] },
      { ...base, sessionId: 'c-2', turnIndex: 1, said: 'Do you mend brass?', lookUps: [{ question: '<18 chars>', retriever: 'keyword', candidates: [{ topic: 'returns', score: 1 }], reading: { choice: 'unanswered', p: 0.9 }, outcome: 'none', ms: 3 }],
        gapNotes: [{ question: '<23 chars>', lookUps: [{ outcome: 'none', nearest: 'returns' }], journey: 'root' }] },
      { ...base, sessionId: 'c-3', turnIndex: 1, said: 'Do you open on holidays?', lookUps: [], gapNotes: [{ question: '<30 chars>', lookUps: [] }] },
    ];
    const { turns } = turnsOfLines(records.map((r) => JSON.stringify(r)), 'trace.jsonl');
    const { gaps } = collectGaps(turns, { topicSlots: new Set(), informational: new Set(), nearest: (w) => (w.includes('holidays') ? 'returns' : null) });
    expect(gaps).toEqual([
      expect.objectContaining({ kind: 'noted', topic: 'care', near: 'passage', words: 'Is steam all right on it?', note: 'Whether steam cleaning is all right on a mended item', sessionId: 'c-1' }),
      expect.objectContaining({ kind: 'noted', topic: 'returns', near: 'nominated', words: 'Do you mend brass?', sessionId: 'c-2' }),
      expect.objectContaining({ kind: 'noted', topic: 'returns', near: 'keyword', words: 'Do you open on holidays?', sessionId: 'c-3' }),
    ]);
    expect(gaps[1]!.note).toBeUndefined();
    // A passage withheld on a turn with a note is still a gap of its own, with its own fix (a person approves it again), beside the note.
    const withheld = { ...base, sessionId: 'c-4', turnIndex: 1, said: 'Can I return it?', lookUps: [{ question: '<16 chars>', retriever: 'keyword', candidates: [{ topic: 'returns', score: 1 }], outcome: 'withheld', topic: 'returns', withheld: { why: 'stale', id: 'returns-1' }, ms: 3 }],
      gapNotes: [{ question: '<26 chars>', lookUps: [{ outcome: 'withheld', topic: 'returns' }] }] };
    const both = collectGaps(turnsOfLines([JSON.stringify(withheld)], 'trace.jsonl').turns, { topicSlots: new Set(), informational: new Set(), nearest: () => null }).gaps;
    expect(both).toEqual([
      expect.objectContaining({ kind: 'noted', topic: 'returns', near: 'passage', lookedUp: 'withheld', words: 'Can I return it?' }),
      expect.objectContaining({ kind: 'unavailable', topic: 'returns', reason: 'stale', passage: { id: 'returns-1', document: null, section: null } }),
    ]);
    expect(converseFacts([withheld]).gaps).toEqual({ noted: 1, unavailable: 1 });
    // The console counts them where it counts unanswered lookups.
    expect(converseFacts([records[0]!]).gaps).toEqual({ noted: 1 });
    expect(converseFacts([records[2]!]).gapTopics).toEqual({ '~': expect.objectContaining({ n: 1 }) });
  });

  it('the judge is given the approved passages the call looked up, as part of the business information', () => {
    const actions: AuditedAction[] = [{ tool: LOOK_UP, params: { question: '<20 chars>' }, verdict: 'ALLOW', result: '{"topic":"Caring"...', passage: { id: 'care-1', title: 'Caring for a mended item', answer: 'Wipe a mended item with a dry cloth.' } }];
    const input = judgeInput('Example Visits: home visits.', { id: 'p', goal: 'Ask how to care for it', truth: { question: 'how to care for a mended item' }, manner: 'brief', expects: 'answer' }, { persona: 'p', turns: [], ended: 'line', firstWordMs: [] }, actions);
    const business = input.split('## The caller')[0]!;
    expect(business).toContain('- Caring for a mended item: Wipe a mended item with a dry cloth.');
  });

  it('the judge is given each gap note as what the line recorded for the business, never a claim to the caller', () => {
    const actions: AuditedAction[] = [{ tool: UNANSWERED_QUESTION, params: { question: '<20 chars>' }, verdict: 'ALLOW', result: 'Recorded for the business to review.' }];
    const input = judgeInput('Example Visits: home visits.', { id: 'p', goal: 'Ask about brass', truth: {}, manner: 'brief', expects: 'answer' }, { persona: 'p', turns: [], ended: 'line', firstWordMs: [] }, actions);
    expect(input).toContain('## The actions the gate decided\n(none)');
    expect(input).toContain('## What the line recorded for the business to review (said to no one on the call, so no claim to the caller)\n- unanswered_question(question=<20 chars>)');
  });
});

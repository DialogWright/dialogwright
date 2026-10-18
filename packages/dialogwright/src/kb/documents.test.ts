import { afterAll, describe, expect, it } from 'vitest';
import { sayText } from '../channel/actions';
import { speechEvent, type SessionEvent } from '../channel/events';
import { registerApp } from '../core/app/registry';
import type { App } from '../core/app/types';
import type { Session } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { resolve, type TurnResult } from '../core/turn';
import { defineApp } from '../define/defineApp';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { noulAnswer } from '../jev/distributions';
import type { AnswerMap, JevClient } from '../jev/types';
import { FakeRenderClient, type FakeRenderOptions } from '../render/fake';
import { SECTIONS_INSTRUCTIONS, instructionsOf } from '../render/prompt';
import { renderTurn, type RenderedTurn } from '../render/turn';
import type { Renderer, SpanAct } from '../render/types';
import { DOCUMENTS_DRIFT_QUESTION_ID } from '../render/checks';
import { choice, noul } from '../testing/answers';
import { approveDocument, placeOf } from './approval';
import { APP_EDITS, BASE, call, calls, cleanScratch, codeFor, folder, nominated, TODAY, VISITOR_GUIDE, type Edit } from './__fixtures__/libraryKbApp';
import type { SectionRetriever } from './sections';
import type { SectionNomination } from './types';

/**
 * Answers from approved documents (kb.yaml documents, docs/designs/2026-10-17-kb-documents.md), on the
 * library's line: its visitor guide (Wi-Fi, printing, parking, a lost card; a note for staff left
 * out) approved for summarizing in a scratch copy, with summarizing on. A question no topic answers is
 * answered from the sections the decision model says answer it, worded from them, held to them by the
 * checks and the judge, and the line's fallback (the not-found line, or the best section's opening) said
 * whenever it cannot be worded. Each turn is resolved by the core and rendered as runTurn renders it.
 */

afterAll(cleanScratch);

const DOCUMENTS_LINES = `
  # Answers from documents
  kb_documents_answer:
    text: '{answer}'
    interruptible: false
    generate:
      answer:
        from: sections
        goal: Answer the caller's question from the sections, in a sentence or two.
  kb_not_found:
    text: I couldn't find anything on that.
    interruptible: true
    variants:
      - I'm not seeing anything about that in what I have.
  kb_documents_opening:
    text: "Here's what our guide says: {opening}"
    interruptible: false
`;

/** The library with its visitor guide approved for summarizing and summarizing on; `retry` on its documents line. */
function documentsApp(id: string, options: { approve?: boolean; retry?: boolean; onFail?: 'opening'; edits?: Record<string, Edit> } = {}): App {
  const prompts = (t: string): string => {
    const lines = options.retry ? DOCUMENTS_LINES.replace('        goal: Answer', '        retry: 1\n        goal: Answer') : DOCUMENTS_LINES;
    return `${APP_EDITS['prompts.yaml']!(t)}${lines}`;
  };
  const forms = (t: string): string => {
    const f = APP_EDITS['forms.yaml']!(t);
    return options.onFail ? f.replace('    answers: { slot: libraryTopic }\n', '    answers: { slot: libraryTopic, documents: { onFail: opening } }\n') : f;
  };
  const dir = folder(id, { 'prompts.yaml': prompts, 'forms.yaml': forms, 'kb/kb.yaml': (t) => `${t.trimEnd()}\ndocuments:\n  summarize: on\n`, 'kb/sources/visitor-guide.yaml': VISITOR_GUIDE, ...(options.edits ?? {}) });
  if (options.approve !== false) {
    const place = placeOf(dir, 'library');
    if (typeof place === 'string') throw new Error(place);
    expect(approveDocument(place, 'visitor-guide', { by: 'Riley Moreno', owner: 'Branch Services', today: TODAY })).toMatchObject({ outcome: 'approved' });
  }
  const app = defineApp(dir, codeFor(dir));
  registerApp(app);
  return app;
}

const APP = documentsApp('library-documents');
const WIFI = 'Every branch has free Wi-Fi. Join the network ExampleTownLibrary; no password is needed. Sessions end when the branch closes.';

/** The sections nominated for a question, as runTurn's retrieval would give them: the app's own section retriever's, by key. */
function sectionsOf(app: App, ...keys: string[]): SectionNomination[] {
  const r = app.knowledge!.sections as SectionRetriever;
  return keys.map((key, i) => {
    const s = r.sections.find((x) => x.key === key)!;
    return { key, document: s.document, documentTitle: s.documentTitle, heading: s.heading, text: s.text, score: 1 - i / 10, via: 'keyword' as const };
  });
}

interface Turn { before: Session; event: SessionEvent; result: TurnResult }

/** A question at the open, its topic question read as `topic`, and each nominated section's yes-or-no as `sections`. */
function asked(app: App, text: string, topic: Record<string, number>, sections: Record<string, number>, topics: string[] = ['opening_hours']): Turn {
  const c = call(app);
  const keys = Object.keys(sections);
  const answers: AnswerMap = { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice(topic) };
  keys.forEach((_, i) => { answers[`libraryTopicSection${i + 1}`] = noul(Object.values(sections)[i]!); });
  const event = speechEvent(text, true);
  const before = c.last.session;
  const result = resolve(before, event, answers, { ...c.t, knowledge: { nominated: nominated(...topics), sections: sectionsOf(app, ...keys) } });
  return { before, event, result: { ...result, screen: { value: 0.02, fired: false, error: null } } };
}

const judge = (app: App): JevClient => new HeuristicStubClient({ todayIso: TODAY, app });
/** A judge that reads every wording at `score`. */
const at = (score: number | (() => number)): JevClient => {
  const base = judge(APP);
  return { ask: async (req) => (Object.hasOwn(req.questions, DOCUMENTS_DRIFT_QUESTION_ID) ? { answers: { [DOCUMENTS_DRIFT_QUESTION_ID]: noulAnswer(typeof score === 'number' ? score : score()) }, model: 'stub', usage: { inputTokens: 1, outputTokens: 1, estimated: false }, latencyMs: 0, source: 'stub:heuristic' } : base.ask(req)) };
};
const renderer = (opts: FakeRenderOptions = {}): Renderer & { client: FakeRenderClient } => ({ client: new FakeRenderClient(opts), share: 100 });
async function rendered(app: App, turn: Turn, r: Renderer & { client: FakeRenderClient }, drift: JevClient = judge(app)): Promise<RenderedTurn> {
  const out = await renderTurn({ before: turn.before, result: turn.result, event: turn.event, renderer: { ...r, drift }, client: drift, thresholds: DEFAULT_THRESHOLDS });
  expect(out).not.toBeNull();
  return out!;
}
const docLine = (out: RenderedTurn) => out.record.lines.find((l) => l.promptId === 'kb_documents_answer')!;

describe('answers from documents: the sections the decision model says answer it', () => {
  it('no topic answers, a section does: the gated read resolves it, and the line carries its fallback with the section beside it', () => {
    const t = asked(APP, 'is there wifi at the library', { unanswered: 0.9, opening_hours: 0.05, none: 0.05 }, { 'visitor-guide#wifi': 0.93, 'visitor-guide#printing': 0.04 });
    expect(calls(t.result)).toEqual(['findPassage(topic=sections:visitor-guide#wifi) ALLOW: documents visitor-guide#wifi']);
    expect(t.result.kb).toMatchObject({ passageId: 'document:visitor-guide', topic: 'documents', from: 'documents', sections: ['visitor-guide#wifi'], fresh: true, document: 'Example Town Library Visitor Guide', approvedBy: 'Riley Moreno' });
    const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((a) => a.promptId === 'kb_documents_answer') : undefined;
    expect(ack?.vars).toEqual({ answer: "I couldn't find anything on that.", answerSource: WIFI, answerHold: 'kb_hold', answerQuestion: 'is there wifi at the library' });
    expect(t.result.audit.find((r) => r.type === 'kb_answer')?.detail).toMatchObject({ passageId: 'document:visitor-guide', from: 'documents', sections: ['visitor-guide#wifi'] });
  });

  it('a topic wins over a section; a turn that asks nothing is never answered from one; a section under the bar answers nothing', () => {
    const topic = asked(APP, 'when are you open, and is there wifi', { opening_hours: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.9 });
    expect(topic.result.session.slots.libraryTopic!.value).toBeNull(); // the form answered and closed
    expect(calls(topic.result)[0]).toMatch(/^findPassage\(topic=opening_hours\)/);
    const nothing = asked(APP, 'i have a question', { none: 0.95, unanswered: 0.05 }, { 'visitor-guide#wifi': 0.7 });
    expect(nothing.result.decision).toMatchObject({ promptId: 'ask_libraryTopic' });
    const under = asked(APP, 'can i bring my dog', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#parking': 0.4 });
    expect(under.result.decision).toMatchObject({ promptId: 'ask_libraryTopic', acks: [expect.anything(), { promptId: 'kb_not_found', vars: {} }] });
  });

  it('none before a person approves the document: no section retriever, and the question is as it was', () => {
    const app = documentsApp('library-documents-unapproved', { approve: false });
    expect(app.knowledge!.sections).toBeUndefined();
  });
});

describe('the reply to a question nothing answers (kb_not_found, kb_guide)', () => {
  const guided = documentsApp('library-documents-guide', { edits: { 'prompts.yaml': (t) => `${APP_EDITS['prompts.yaml']!(t)}${DOCUMENTS_LINES}  kb_guide:\n    text: I can tell you about our hours, renewing a card, late fees, Wi-Fi and printing.\n    interruptible: true\n` } });
  const nothing = (c: ReturnType<typeof call>, prompted: boolean) => {
    const answers: AnswerMap = { ...BASE, intent: choice(prompted ? { none: 0.95, other: 0.05 } : { ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ unanswered: 0.9, none: 0.1 }) };
    c.last = resolve(c.last.session, speechEvent('can i bring my dog', true), answers, { ...c.t, knowledge: { nominated: nominated('opening_hours') } });
    return c.last;
  };
  const lines = (r: TurnResult): string[] => ('acks' in r.decision ? r.decision.acks.map((a) => a.promptId) : []).concat('promptId' in r.decision ? [r.decision.promptId] : []);

  it('the not-found line in turn, the guide the first time and again after two in a row without it, then the question; never counted', () => {
    const c = call(guided);
    const seen = [lines(nothing(c, false))];
    for (let i = 0; i < 4; i++) seen.push(lines(nothing(c, true)));
    expect(seen).toEqual([
      ['ack_intent', 'kb_not_found', 'kb_guide', 'ask_libraryTopic'],
      ['kb_not_found.v2', 'ask_libraryTopic'],
      ['kb_not_found', 'ask_libraryTopic'],
      ['kb_not_found.v2', 'kb_guide', 'ask_libraryTopic'],
      ['kb_not_found', 'ask_libraryTopic'],
    ]);
    expect(c.last.session.slots.libraryTopic).toMatchObject({ attempts: 0 });
  });
});

describe('the answer worded from the sections, checked against them', () => {
  it('worded for the question: the act carries the sections and the question; the documents judge passes it; kb_worded says from documents', async () => {
    const t = asked(APP, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const r = renderer();
    const out = await rendered(APP, t, r);
    const act = r.client.askedSpans[0]!.act as SpanAct;
    expect(act).toMatchObject({ kind: 'span', content: [{ name: 'answer', value: WIFI }], style: { words: 60 }, answer: { question: 'is there wifi at the library', from: 'sections' } });
    expect(instructionsOf(act)).toBe(SECTIONS_INSTRUCTIONS);
    expect(docLine(out)).toMatchObject({ mode: 'generated', said: 'Every branch has free Wi-Fi.', fixed: "I couldn't find anything on that." });
    expect(sayText(out.actions)).toContain('Every branch has free Wi-Fi.');
    expect(sayText(out.actions)).not.toContain('Sessions end');
    expect(out.audit).toContainEqual({ type: 'kb_worded', detail: expect.objectContaining({ prompt: 'kb_documents_answer', passageId: 'document:visitor-guide', from: 'documents', sections: ['visitor-guide#wifi'] }) });
  });

  it('refused by the judge, or with a figure the sections do not have: the fallback, the not-found line, said in its place', async () => {
    const t = asked(APP, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const refused = await rendered(APP, t, renderer(), at(0.9));
    expect(docLine(refused)).toMatchObject({ mode: 'fixed', fallback: 'drift', judge: { score: 0.9 } });
    expect(sayText(refused.actions)).toContain("I couldn't find anything on that.");
    expect(sayText(refused.actions)).not.toContain('Wi-Fi');
    const figure = await rendered(APP, t, renderer({ eachSpan: () => 'Wi-Fi is free for 3 hours.' }));
    expect(docLine(figure)).toMatchObject({ mode: 'fixed', fallback: 'foreign' });
  });

  it('with retry: 1, a wording the judge refused is asked once more, told it was refused; each draw judged', async () => {
    const app = documentsApp('library-documents-retry', { retry: true });
    const t = asked(app, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    let n = 0;
    const firstRefused = at(() => (n++ === 0 ? 0.9 : 0.05));
    const r = renderer({ eachSpan: () => (r.client.askedSpans.length === 1 ? 'Wi-Fi is free and needs no password, all day and night.' : 'Every branch has free Wi-Fi.') });
    const out = await rendered(app, t, r, firstRefused);
    expect(r.client.askedSpans).toHaveLength(2);
    expect((r.client.askedSpans[1]!.act as SpanAct).answer).toMatchObject({ refused: 'Wi-Fi is free and needs no password, all day and night.' });
    expect(docLine(out)).toMatchObject({ mode: 'generated', said: 'Every branch has free Wi-Fi.' });
    // Without retry, one draw only.
    const once = renderer();
    await rendered(APP, asked(APP, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 }), once, at(0.9));
    expect(once.client.askedSpans).toHaveLength(1);
  });

  it('with retry: 1, a wording with a figure the sections do not have is asked once more too; one too long is not', async () => {
    const app = documentsApp('library-documents-retry-figure', { retry: true });
    const t = asked(app, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const r = renderer({ eachSpan: () => (r.client.askedSpans.length === 1 ? 'Wi-Fi is free for the first hour.' : 'Every branch has free Wi-Fi.') });
    const out = await rendered(app, t, r);
    expect(r.client.askedSpans).toHaveLength(2);
    expect((r.client.askedSpans[1]!.act as SpanAct).answer).toMatchObject({ refused: 'Wi-Fi is free for the first hour.' });
    expect(docLine(out)).toMatchObject({ mode: 'generated', said: 'Every branch has free Wi-Fi.' });
    // A wording over its word budget says no more than the sections: it is not asked again.
    const long = renderer({ eachSpan: () => Array.from({ length: 70 }, () => 'free').join(' ') });
    const over = await rendered(app, t, long);
    expect(long.client.askedSpans).toHaveLength(1);
    expect(docLine(over)).toMatchObject({ mode: 'fixed', fallback: 'words' });
  });

  it('a documents cutoff of its own (style.yaml judge.documentsRefuseAt) holds answers from documents alone', async () => {
    const style = "# yaml-language-server: $schema=../../../../packages/dialogwright/schemas/style.schema.json\njudge:\n  refuseAt: 0.3\n  documentsRefuseAt: 0.5\n";
    const strict = documentsApp('library-documents-cutoff', { edits: { 'style.yaml': style } });
    const t = asked(strict, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const out = await rendered(strict, t, renderer(), at(0.4));
    expect(docLine(out)).toMatchObject({ mode: 'generated', judge: { score: 0.4, refuseAt: 0.5 } });
    // Without it, the app's refuseAt (0.3) holds them too.
    const plain = documentsApp('library-documents-cutoff-plain', { edits: { 'style.yaml': "# yaml-language-server: $schema=../../../../packages/dialogwright/schemas/style.schema.json\njudge:\n  refuseAt: 0.3\n" } });
    const u = asked(plain, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    expect(docLine(await rendered(plain, u, renderer(), at(0.4)))).toMatchObject({ mode: 'fixed', fallback: 'drift', judge: { refuseAt: 0.3 } });
  });

  it('onFail: opening: the best section whole where it fits the answer\'s word budget, word for word, in the opening frame', () => {
    const app = documentsApp('library-documents-opening', { onFail: 'opening' });
    const t = asked(app, 'is there wifi', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((a) => a.promptId === 'kb_documents_answer') : undefined;
    expect(ack?.vars.answer).toBe("Here's what our guide says: Every branch has free Wi-Fi. Join the network ExampleTownLibrary; no password is needed. Sessions end when the branch closes.");
  });

  it('onFail: opening: a table over the word budget, its first two rows, each a sentence of its own, never the whole table run together', () => {
    const branches = ['main', 'east', 'west', 'north', 'south', 'river', 'hill', 'park', 'harbor', 'market'];
    const rows = VISITOR_GUIDE.replace(
      '    text: Every branch has free Wi-Fi. Join the network ExampleTownLibrary; no password is needed. Sessions end when the branch closes.\n',
      `    text: |-\n${branches.map((b) => `      Wi-Fi at the ${b} branch: free; password needed: no\n`).join('')}`,
    );
    const app = documentsApp('library-documents-opening-rows', { onFail: 'opening', edits: { 'kb/sources/visitor-guide.yaml': rows } });
    const t = asked(app, 'is there wifi', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((a) => a.promptId === 'kb_documents_answer') : undefined;
    expect(ack?.vars.answer).toBe("Here's what our guide says: Wi-Fi at the main branch: free; password needed: no. Wi-Fi at the east branch: free; password needed: no.");
  });

  it('the not-found fallback says the next of its wordings each time it is chosen', () => {
    const c = call(APP);
    let session = c.last.session;
    const said: string[] = [];
    for (let i = 0; i < 3; i++) {
      const answers: AnswerMap = { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ unanswered: 0.9, none: 0.1 }), libraryTopicSection1: noul(0.93) };
      const r = resolve(session, speechEvent('is there wifi', true), answers, { ...c.t, knowledge: { nominated: nominated('opening_hours'), sections: sectionsOf(APP, 'visitor-guide#wifi') } });
      const ack = 'acks' in r.decision ? r.decision.acks.find((a) => a.promptId === 'kb_documents_answer') : undefined;
      said.push(ack?.vars.answer ?? '');
      session = r.session;
    }
    expect(said).toEqual(["I couldn't find anything on that.", "I'm not seeing anything about that in what I have.", "I couldn't find anything on that."]);
  });
});

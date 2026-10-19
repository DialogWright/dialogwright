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
import { SECTIONS_INSTRUCTIONS, SECTIONS_INSTRUCTIONS_EARLIER, instructionsOf } from '../render/prompt';
import { buildTurnState } from '../core/state';
import { slotContext } from '../core/turn';
import { slotSpecOf } from '../core/app/lookup';
import { mergeRanked } from './sections';
import { renderTurn, type RenderedTurn } from '../render/turn';
import type { Renderer, SpanAct } from '../render/types';
import { ANSWER_LINE_QUESTION_PREFIX, DOCUMENTS_DRIFT_QUESTION_ID } from '../render/checks';
import { choice, noul } from '../testing/answers';
import { approveDocument, placeOf } from './approval';
import { frameViolations } from '../testing/adversarial/run';
import { withSources } from '../core/sources';
import { FIGURES } from '../render/config';
import { answerSourcesOf } from './answer';
import type { Action, SaySource } from '../channel/actions';
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
function documentsApp(id: string, options: { approve?: boolean; retry?: boolean; onFail?: 'opening' | 'lines'; edits?: Record<string, Edit> } = {}): App {
  const prompts = (t: string): string => {
    const lines = options.retry ? DOCUMENTS_LINES.replace('        goal: Answer', '        retry: 1\n        goal: Answer') : DOCUMENTS_LINES;
    return `${APP_EDITS['prompts.yaml']!(t)}${lines}`;
  };
  const forms = (t: string): string => {
    const f = APP_EDITS['forms.yaml']!(t);
    return options.onFail ? f.replace('    answers: { slot: libraryTopic }\n', `    answers: { slot: libraryTopic, documents: { onFail: ${options.onFail} } }\n`) : f;
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
function asked(app: App, text: string, topic: Record<string, number>, sections: Record<string, number>, topics: string[] = ['opening_hours'], after?: Session): Turn {
  const c = call(app);
  const keys = Object.keys(sections);
  const answers: AnswerMap = { ...BASE, intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice(topic) };
  keys.forEach((_, i) => { answers[`libraryTopicSection${i + 1}`] = noul(Object.values(sections)[i]!); });
  const event = speechEvent(text, true);
  const before = after ?? c.last.session;
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

  it('how figures are written (style.yaml figures) goes to the model with the style, and nothing where the app says none', async () => {
    const symbols = documentsApp('library-documents-figures', { edits: { 'style.yaml': '# yaml-language-server: $schema=../../../../packages/dialogwright/schemas/style.schema.json\nfigures: symbols\n' } });
    const t = asked(symbols, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const r = renderer();
    await rendered(symbols, t, r, at(0.1));
    expect(r.client.askedSpans[0]!.act.style.figures).toBe(FIGURES.symbols);
    const plain = renderer();
    await rendered(APP, asked(APP, 'is there wifi at the library', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 }), plain, at(0.1));
    expect(plain.client.askedSpans[0]!.act.style).not.toHaveProperty('figures');
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

  it('onFail: opening: a list\'s markers left out (a bullet glyph, a dash opening a line), its words as they are', () => {
    const list = VISITOR_GUIDE.replace(
      '    text: Every branch has free Wi-Fi. Join the network ExampleTownLibrary; no password is needed. Sessions end when the branch closes.\n',
      '    text: |-\n      Free Wi-Fi at: \u2022 the main branch; \u2022 the east branch; or \u2022 the mobile library\n      - Sessions end when the branch closes.\n',
    );
    const app = documentsApp('library-documents-opening-list', { onFail: 'opening', edits: { 'kb/sources/visitor-guide.yaml': list } });
    const t = asked(app, 'is there wifi', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
    const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((a) => a.promptId === 'kb_documents_answer') : undefined;
    expect(ack?.vars.answer).toBe("Here's what our guide says: Free Wi-Fi at: the main branch; the east branch; or the mobile library. Sessions end when the branch closes.");
  });

  describe('onFail: lines: the lines the decision model says answer the question, word for word', () => {
    const ROWS = ['Printing in black and white: 15 cents a page', 'Printing in color: 50 cents a page', 'Copies of a map: free at the desk', 'Scanning to email: free'];
    let built: App | undefined;
    const tableApp = (): App => (built ??= documentsApp('library-documents-lines', {
      onFail: 'lines',
      edits: { 'kb/sources/visitor-guide.yaml': VISITOR_GUIDE.replace('    text: Printing and copying cost 15 cents a page in black and white and 50 cents a page in color. Print from a branch computer, or send a file to print@library.example.com and collect it at the desk within two days.\n', `    text: |-\n${ROWS.map((r) => `      ${r}\n`).join('')}`) },
    }));
    const PRINTING = { 'visitor-guide#printing': 0.93 };
    /** A judge that refuses every wording, and reads each line of the lines question at `lines[i]` (0 where unnamed). */
    const linesJudge = (lines: Record<number, number>, asked: unknown[] = []): JevClient => ({
      ask: async (req) => {
        const ids = Object.keys(req.questions);
        if (ids.includes(DOCUMENTS_DRIFT_QUESTION_ID)) return { answers: { [DOCUMENTS_DRIFT_QUESTION_ID]: noulAnswer(0.9) }, model: 'stub', usage: { inputTokens: 1, outputTokens: 1, estimated: false }, latencyMs: 0, source: 'stub:heuristic' };
        if (ids.some((id) => id.startsWith(ANSWER_LINE_QUESTION_PREFIX))) {
          asked.push((req.state as { answer: { sections: { heading: string; lines: string[] }[] } }).answer.sections);
          return { answers: Object.fromEntries(ids.map((id) => [id, noulAnswer(lines[Number(id.slice(ANSWER_LINE_QUESTION_PREFIX.length))] ?? 0.02)])), model: 'stub', usage: { inputTokens: 1, outputTokens: 1, estimated: false }, latencyMs: 0, source: 'stub:heuristic' };
        }
        return judge(APP).ask(req);
      },
    });

    it('the core says the opening, with the sections\' lines beside it, one a line, ended, and each line\'s section heading', () => {
      const t = asked(tableApp(), 'how much is color printing', { unanswered: 0.9, none: 0.1 }, PRINTING);
      const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      expect(ack?.vars.answer).toBe("Here's what our guide says: Printing in black and white: 15 cents a page. Printing in color: 50 cents a page. Copies of a map: free at the desk. Scanning to email: free.");
      expect(ack?.vars.answerLines).toBe(ROWS.map((r) => `${r}.`).join('\n'));
      expect(ack?.vars.answerLineHeadings).toBe(ROWS.map(() => 'Printing and copies').join('\n'));
    });

    it('not worded: the rows that answer it said under their section\'s heading in the opening\'s frame, the lines asked numbered under it, the record and the audit saying which', async () => {
      const app = tableApp();
      const t = asked(app, 'how much is color printing', { unanswered: 0.9, none: 0.1 }, PRINTING);
      const seen: unknown[] = [];
      const out = await rendered(app, t, renderer(), linesJudge({ 2: 0.91 }, seen));
      expect(seen).toEqual([[{ heading: 'Printing and copies', lines: ROWS.map((r, i) => `${i + 1}. ${r}.`) }]]);
      expect(sayText(out.actions)).toContain("Here's what our guide says: Printing and copies. Printing in color: 50 cents a page.");
      expect(sayText(out.actions)).not.toContain('black and white');
      expect(docLine(out)).toMatchObject({ mode: 'fixed', fallback: 'drift', lines: { chosen: [2], of: 4, said: "Here's what our guide says: Printing and copies. Printing in color: 50 cents a page." } });
      expect(out.audit).toContainEqual({ type: 'render_fallback', detail: { prompt: 'kb_documents_answer', span: 'answer', reason: 'drift', lines: 1 } });
      // The adversarial suite's frame-kept holds it (the document's own lines, rebuilt from the turn's), and
      // fails a record whose chosen lines are not the ones said.
      type FrameTurn = Parameters<typeof frameViolations>[1][number];
      const turn = { record: { render: out.record }, result: { ...t.result, actions: out.actions } } as unknown as FrameTurn;
      expect(frameViolations(app, [turn])).toEqual([]);
      const other = { ...turn, record: { render: { ...out.record, lines: out.record.lines.map((l) => (l.lines ? { ...l, lines: { ...l.lines, chosen: [1] } } : l)) } } } as unknown as FrameTurn;
      expect(frameViolations(app, [other])).toEqual([expect.stringMatching(/^frame-kept: on turn 1, kb_documents_answer was said as "Here's what our guide says: Printing and copies\. Printing in color/)]);
      const beyond = { ...turn, record: { render: { ...out.record, lines: out.record.lines.map((l) => (l.lines ? { ...l, lines: { ...l.lines, chosen: [9] } } : l)) } } } as unknown as FrameTurn;
      expect(frameViolations(app, [beyond])[0]).toMatch(/chose lines its sections do not have \(9 of 4\)/);
    });

    it('none answers, or the question is not answered: the opening, as with onFail: opening', async () => {
      const app = tableApp();
      const t = asked(app, 'how much is color printing', { unanswered: 0.9, none: 0.1 }, PRINTING);
      const none = await rendered(app, t, renderer(), linesJudge({}));
      expect(sayText(none.actions)).toContain('Printing in black and white: 15 cents a page. Printing in color');
      expect(docLine(none).lines).toBeUndefined();
      const failing: JevClient = { ask: async (req) => (Object.keys(req.questions).some((id) => id.startsWith(ANSWER_LINE_QUESTION_PREFIX)) ? Promise.reject(new Error('down')) : linesJudge({}).ask(req)) };
      const erred = await rendered(app, t, renderer(), failing);
      expect(docLine(erred)).toMatchObject({ mode: 'fixed', fallback: 'drift' });
      expect(docLine(erred).lines).toBeUndefined();
    });

    it('two sections share the lines asked, a long one never crowding out the next; each line chosen said under its own section\'s heading', async () => {
      const branches = Array.from({ length: 45 }, (_, i) => `Parking at branch ${i + 1}: free for two hours`);
      const app = documentsApp('library-documents-lines-shared', {
        onFail: 'lines',
        edits: { 'kb/sources/visitor-guide.yaml': VISITOR_GUIDE.replace('    text: Every branch has free parking for up to two hours. Spaces by the entrance are kept for drivers with a disability permit.\n', `    text: |-\n${branches.map((r) => `      ${r}\n`).join('')}`) },
      });
      const t = asked(app, 'what if I lose my card and where do I park', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#parking': 0.95, 'visitor-guide#lost-card': 0.9 });
      const ack = 'acks' in t.result.decision ? t.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      const headings = (ack?.vars.answerLineHeadings ?? '').split('\n');
      expect(headings).toEqual([...Array.from({ length: 38 }, () => 'Parking'), 'A lost library card', 'A lost library card']);
      const out = await rendered(app, t, renderer(), linesJudge({ 1: 0.9, 39: 0.9 }));
      expect(docLine(out).lines).toMatchObject({ chosen: [1, 39], of: 40, said: "Here's what our guide says: Parking. Parking at branch 1: free for two hours. A lost library card. A lost card is replaced at any branch desk with a photo ID." });
    });

    it('on a chat with chat.sources on, the answer says where it comes from: its sections, narrowed on a fallback to those whose lines were said', async () => {
      const branches = Array.from({ length: 3 }, (_, i) => `Parking at branch ${i + 1}: free for two hours`);
      const app = documentsApp('library-documents-sources', {
        onFail: 'lines',
        // The glossary rewords a heading: the lines carry its words, the citation the document's own.
        edits: { 'kb/glossary.yaml': 'library card: borrower card\n', 'kb/sources/visitor-guide.yaml': VISITOR_GUIDE.replace('    text: Every branch has free parking for up to two hours. Spaces by the entrance are kept for drivers with a disability permit.\n', `    text: |-\n${branches.map((r) => `      ${r}\n`).join('')}`) },
      });
      const t = asked(app, 'what if I lose my card and where do I park', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#parking': 0.95, 'visitor-guide#lost-card': 0.9 });
      const kb = app.knowledge!.kb!;
      const both = [{ document: 'Example Town Library Visitor Guide', section: 'Parking' }, { document: 'Example Town Library Visitor Guide', section: 'A lost library card' }];
      expect(answerSourcesOf(kb, t.result.kb!)).toEqual(both);
      const shown = { ...app, chat: { sources: 'on' as const } } as App;
      const sourcesOn = (actions: Action[]): (SaySource[] | undefined)[] => actions.flatMap((a) => (a.type === 'say' ? [a.sources] : []));
      const copy = (): Action[] => t.result.actions.map((a) => ({ ...a }) as Action);
      // On a voice call, with the setting off, or for an answer that may not be said: none.
      expect(sourcesOn(withSources(shown, copy(), t.result.kb, { shown: false })).every((x) => x === undefined)).toBe(true);
      expect(sourcesOn(withSources(app, copy(), t.result.kb, { shown: true })).every((x) => x === undefined)).toBe(true);
      expect(sourcesOn(withSources(shown, copy(), { ...t.result.kb!, fresh: false }, { shown: true })).every((x) => x === undefined)).toBe(true);
      // On a chat: the answer's line only, every section it was drawn from.
      const actions = withSources(shown, t.result.actions, t.result.kb, { shown: true });
      expect(sourcesOn(actions).filter((x) => x !== undefined)).toEqual([both]);
      // Not worded, said as the lost card's line alone: that section alone.
      const out = await rendered(app, t, renderer(), linesJudge({ 4: 0.9 }));
      expect(docLine(out).lines).toMatchObject({ chosen: [4] });
      expect(sourcesOn(out.actions).filter((x) => x !== undefined)).toEqual([[both[1]]]);
      expect(sayText(out.actions)).toContain('A lost borrower card.');
    });

    it('a wording that passes is said, and the lines are never asked; with onFail: opening they are never carried', async () => {
      const app = tableApp();
      const t = asked(app, 'how much is color printing', { unanswered: 0.9, none: 0.1 }, PRINTING);
      const seen: unknown[] = [];
      const passing: JevClient = { ask: async (req) => (Object.hasOwn(req.questions, DOCUMENTS_DRIFT_QUESTION_ID) ? { answers: { [DOCUMENTS_DRIFT_QUESTION_ID]: noulAnswer(0.05) }, model: 'stub', usage: { inputTokens: 1, outputTokens: 1, estimated: false }, latencyMs: 0, source: 'stub:heuristic' } : linesJudge({}, seen).ask(req)) };
      const out = await rendered(app, t, renderer({ eachSpan: () => 'Color printing is 50 cents a page.' }), passing);
      expect(docLine(out)).toMatchObject({ mode: 'generated', said: 'Color printing is 50 cents a page.' });
      expect(seen).toEqual([]);
      const opening = asked(documentsApp('library-documents-opening-nolines', { onFail: 'opening' }), 'is there wifi', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#wifi': 0.93 });
      const ack = 'acks' in opening.result.decision ? opening.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      expect(ack?.vars.answerLines).toBeUndefined();
    });
  });

  describe('follow-ups (kb.yaml documents.followUps on): a question read with the caller\'s earlier one', () => {
    let built: App | undefined;
    const followApp = (): App => (built ??= documentsApp('library-documents-follow-ups', { edits: { 'kb/kb.yaml': (t: string) => `${t.trimEnd()}\ndocuments:\n  summarize: on\n  followUps: on\n` } }));
    const FIRST = 'how much is printing';
    const NEXT = 'what about in color';

    it('keeps the question answered, and gives the next answer it, the turn state and each section\'s question reading the follow-up with it', () => {
      const app = followApp();
      const first = asked(app, FIRST, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 });
      // The question, and the sections that answered it (a follow-up's candidates are those and the sections under them).
      expect(first.result.session.kbEarlier).toEqual({ question: FIRST, sections: ['visitor-guide#printing'] });
      const firstAck = 'acks' in first.result.decision ? first.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      expect(firstAck?.vars).not.toHaveProperty('answerEarlier');
      // The next turn's state and section questions read it.
      expect(buildTurnState(first.result.session, { text: NEXT, isFinal: true, dtmf: null }, 0).earlierQuestion).toBe(FIRST);
      const questions = slotSpecOf(app, 'libraryTopic').questions({ ...slotContext(first.result.session, NEXT, call(app).t), sections: sectionsOf(app, 'visitor-guide#printing'), earlier: FIRST } as never);
      expect(String((questions.libraryTopicSection1 as { instructions: string }).instructions)).toMatch(/^Read asr.text, the caller's question\. Would this section of the Example Town Library Visitor Guide answer it\? Only where asr.text cannot be understood on its own \(as "what about for a family\?" cannot\), read it as continuing earlierQuestion, the caller's earlier question on this call\. Printing and copies: /);
      const next = asked(app, NEXT, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 }, ['opening_hours'], first.result.session);
      const ack = 'acks' in next.result.decision ? next.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      expect(ack?.vars).toMatchObject({ answerQuestion: NEXT, answerEarlier: FIRST });
      expect(next.result.session.kbEarlier).toEqual({ question: NEXT, sections: ['visitor-guide#printing'] });
    });

    it('keeps a question the turn found nothing for too, so the next is read with it; without follow-ups, nothing is kept', () => {
      const app = followApp();
      const nothing = asked(app, 'can I borrow a telescope', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.05 });
      const acks = 'acks' in nothing.result.decision ? nothing.result.decision.acks.map((a) => a.promptId) : [];
      expect(acks.some((id) => id.startsWith('kb_not_found'))).toBe(true);
      expect(nothing.result.session.kbEarlier).toEqual({ question: 'can I borrow a telescope' });
      const next = asked(app, 'what about printing a poster', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 }, ['opening_hours'], nothing.result.session);
      const ack = 'acks' in next.result.decision ? next.result.decision.acks.find((x) => x.promptId === 'kb_documents_answer') : undefined;
      expect(ack?.vars).toMatchObject({ answerEarlier: 'can I borrow a telescope' });
      expect(asked(APP, 'can I borrow a telescope', { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.05 }).result.session.kbEarlier).toBeUndefined();
    });

    it('the wording, the judge and the lines picker are given the earlier question, with instructions that name it', async () => {
      const app = followApp();
      const first = asked(app, FIRST, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 });
      const next = asked(app, NEXT, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 }, ['opening_hours'], first.result.session);
      const r = renderer();
      const asks: { questions: string[]; state: unknown }[] = [];
      const watching: JevClient = { ask: async (req) => { asks.push({ questions: Object.keys(req.questions), state: req.state }); return at(0.9).ask(req); } };
      await rendered(app, next, r, watching);
      const act = r.client.askedSpans[0]!.act;
      expect(act.answer).toMatchObject({ question: NEXT, earlier: FIRST });
      expect(instructionsOf(act)).toBe(SECTIONS_INSTRUCTIONS_EARLIER);
      expect(SECTIONS_INSTRUCTIONS_EARLIER).toContain('"answer.earlier", their earlier question on the call');
      const drift = asks.find((a) => a.questions.includes(DOCUMENTS_DRIFT_QUESTION_ID))!;
      expect(drift.state).toMatchObject({ answer: { question: NEXT, earlier: FIRST } });
      // Without follow-ups (the default), none of it: the first answer of any app, and every request as it was.
      const plain = asked(APP, NEXT, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 }, ['opening_hours'], asked(APP, FIRST, { unanswered: 0.9, none: 0.1 }, { 'visitor-guide#printing': 0.93 }).result.session);
      expect(plain.result.session.kbEarlier).toBeUndefined();
      const p = renderer();
      await rendered(APP, plain, p, at(0.1));
      expect(p.client.askedSpans[0]!.act.answer).not.toHaveProperty('earlier');
      expect(instructionsOf(p.client.askedSpans[0]!.act)).toBe(SECTIONS_INSTRUCTIONS);
    });

    it('the section retriever finds a follow-up\'s sections with the earlier question too, merged, only with follow-ups on', async () => {
      const on = followApp().knowledge!.sections as SectionRetriever;
      const off = APP.knowledge!.sections as SectionRetriever;
      const keys = async (r: SectionRetriever, earlier?: string) => (await r.nominate({ text: 'and how much would that be', locale: 'en-US', todayIso: TODAY, ...(earlier !== undefined ? { earlier } : {}) })).map((n) => n.topic);
      // Its words alone find nothing about printing; read with the earlier question, they do.
      expect(await keys(on)).not.toContain('visitor-guide#printing');
      expect(await keys(on, 'can I print at the library')).toContain('visitor-guide#printing');
      expect(await keys(off, 'can I print at the library')).toEqual(await keys(off));
      // The earlier answer's section and the sections under it are candidates too (`earlier`), the follow-up's words alone finding none of them.
      const nested = documentsApp('library-documents-follow-ups-nested', {
        edits: {
          'kb/kb.yaml': (t: string) => `${t.trimEnd()}\ndocuments:\n  summarize: on\n  followUps: on\n`,
          'kb/sources/visitor-guide.yaml': VISITOR_GUIDE.replace('  parking:\n', '  printing/posters:\n    heading: Large posters\n    text: A large poster is printed on the plotter by staff, for 5 dollars a sheet.\n  parking:\n'),
        },
      });
      const r = nested.knowledge!.sections as SectionRetriever;
      const plainKeys = (await r.nominate({ text: 'and how much would that be', locale: 'en-US', todayIso: TODAY })).map((n) => n.topic);
      expect(plainKeys).not.toContain('visitor-guide#printing/posters');
      const withoutAnswer = (await r.nominate({ text: 'and how much would that be', locale: 'en-US', todayIso: TODAY, earlier: 'what else can I do there' })).map((n) => n.topic);
      expect(withoutAnswer).not.toContain('visitor-guide#printing/posters');
      const read = await r.nominate({ text: 'and how much would that be', locale: 'en-US', todayIso: TODAY, earlier: 'what else can I do there', earlierSections: ['visitor-guide#printing'] });
      expect(read.find((n) => n.topic === 'visitor-guide#printing/posters')).toMatchObject({ via: 'earlier' });
      expect(mergeRanked([[{ topic: 'a', title: 'A', score: 1, via: 'dense' }, { topic: 'b', title: 'B', score: 0.5, via: 'dense' }], [{ topic: 'b', title: 'B', score: 1, via: 'keyword' }]], 1)).toEqual([{ topic: 'b', title: 'B', score: 0.032522, via: 'dense' }]);
    });
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

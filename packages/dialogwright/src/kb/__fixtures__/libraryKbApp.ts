import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICE_RELAY } from '../../channel/caps';
import { speechEvent, startEvent } from '../../channel/events';
import { registerApp } from '../../core/app/registry';
import type { App, ToolDef } from '../../core/app/types';
import { newSession } from '../../core/session';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { mockCodeVerifier } from '../../core/tools';
import { resolve, type TurnContext, type TurnResult } from '../../core/turn';
import { defineApp, type AppCode } from '../../define/defineApp';
import { LIBRARY_DIR, LibrarySystems, libraryCode } from '../../define/fixture/app';
import { loadKnowledgeFolder } from '../../define/load';
import { ANONYMOUS } from '../../gate/principal';
import type { AnswerMap } from '../../jev/types';
import { spokenText } from '../../prompts/render';
import { choice, noul, score } from '../../testing/answers';
import { fixedRetriever } from '../../testing/retrievers';
import { defineSlot } from '../../slots/defineSlot';
import { kbAnswerTool } from '../answer';
import { kbCatalog } from '../catalog';
import type { Nomination } from '../types';

/**
 * Example Town Library's line with its knowledge base (./kb) as kb/, for the tests of speaking an
 * answer (../answer.test.ts) and of approval and staleness (../approval.test.ts): a form that answers
 * (forms.yaml `answers:`, the engine's completion) through findPassage (kbAnswerTool, the caller's
 * card kind read from the library's systems) with the late fees' account line read through getFees,
 * and the opening hours as an informational intent's passage. Each app is built from a scratch copy
 * of the folder (`folder`), which a test may edit; the model's answers are written out, and the topics
 * nominated are given to each turn as runTurn's retrieval would give them.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const KB_FIXTURE = join(here, 'kb');
export const TODAY = '2026-10-03';

const scratch: string[] = [];
/** Deletes the scratch folders made so far (a test file's afterAll). */
export function cleanScratch(): void {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The library's systems, with the caller's card kind (the fact the late fees and renewals depend on) and the late fees on it. */
export class KbLibrarySystems extends LibrarySystems {
  cardKind: string | null = 'adult';
  balance: string | null = '2 dollars';
}

export const TOOLS: Record<string, ToolDef> = {
  // The card kind comes from the library's records, never from what the caller said.
  findPassage: kbAnswerTool({ facts: (_params, sys) => {
    const kind = (sys as KbLibrarySystems).cardKind;
    return kind === null ? null : { card: kind };
  } }),
  getFees: {
    params: ['topic'],
    fields: ['balance'],
    run(_call, sys) {
      const { balance } = sys as KbLibrarySystems;
      return balance === null ? { value: { balance: null }, summary: 'no fees on record' } : { value: { balance }, summary: 'fees read' };
    },
  },
};

export type Edit = string | ((text: string) => string) | null;

export const APP_EDITS: Record<string, (text: string) => string> = {
  'app.yaml': (t) => t.replace('prompts:\n  spokenVars: [due]', 'prompts:\n  spokenVars: [due]\n  dataVars: [answer]'),
  'intents.yaml': (t) => t
    .replace('    kind: informational\n    promptId: hours', '    kind: informational\n    passage: opening-hours')
    .replace('  agent:\n', '  ask_library:\n    criteria: Asks a question about the library, its cards or its fees\n    label: answer a question\n    kind: form\n  agent:\n'),
  'forms.yaml': (t) => `${t}  ask_library:\n    slots: [libraryTopic]\n    summaryPromptId: null\n    answers: { slot: libraryTopic }\n`,
  'policy.yaml': (t) => t
    .replace('# How each value', '  findPassage:\n    level: 0\n    rules: [identity]\n  getFees:\n    level: 0\n    rules: [identity]\n# How each value')
    .replace('  branch: keep\n', '  branch: keep\n  topic: keep\n'),
  'prompts.yaml': (t) => `${t}
  # Answers from the knowledge base
  ask_libraryTopic:
    text: What would you like to know?
    interruptible: true
  ask_libraryTopic_retry:
    text: Sorry, what would you like to know about the library?
    interruptible: true
  disambiguate_libraryTopic:
    text: Is that about {a}, or {b}?
    interruptible: true
  kb_answer:
    text: '{answer}'
    interruptible: false
  kb_unavailable:
    text: I'm sorry, I don't have an answer to that I can give you right now.
    interruptible: false
`,
  'locale/es/prompts.yaml': (t) => `${t}
  ask_libraryTopic:
    text: ¿Qué le gustaría saber?
    interruptible: true
  ask_libraryTopic_retry:
    text: Perdone, ¿qué le gustaría saber de la biblioteca?
    interruptible: true
  disambiguate_libraryTopic:
    text: ¿Es sobre {a}, o sobre {b}?
    interruptible: true
  kb_answer:
    text: '{answer}'
    interruptible: false
  kb_unavailable:
    text: Lo siento, ahora no tengo una respuesta que pueda darle.
    interruptible: false
`,
};

/**
 * A scratch copy of the library's folder with the knowledge base as kb/ and the edits above, its id
 * `id`. `edits` (a path from the app folder; null deletes) take the place of the edit above for the
 * same file, and apply to the library's own.
 */
export function folder(id: string, edits: Record<string, Edit> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-kb-answer-'));
  scratch.push(dir);
  cpSync(LIBRARY_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  cpSync(KB_FIXTURE, join(dir, 'kb'), { recursive: true });
  for (const file of new Set([...Object.keys(APP_EDITS), ...Object.keys(edits)])) {
    const edit: Edit | undefined = Object.hasOwn(edits, file) ? edits[file] : APP_EDITS[file];
    const path = join(dir, file);
    if (edit === null) rmSync(path, { force: true });
    else if (edit !== undefined) writeFileSync(path, typeof edit === 'string' ? edit : edit(readFileSync(path, 'utf8')));
  }
  const app = join(dir, 'app.yaml');
  writeFileSync(app, readFileSync(app, 'utf8').replace('id: library\n', `id: ${id}\n`));
  return dir;
}

/** The library's code with the two knowledge tools, the topic slot (over the knowledge base's topics) and a retriever. */
export function codeFor(dir: string): AppCode {
  const kb = loadKnowledgeFolder(join(dir, 'kb')).kb!;
  const libraryTopic = defineSlot('libraryTopic', { type: 'topic' }, undefined, { catalog: kbCatalog(kb) });
  return {
    ...libraryCode,
    slots: { ...libraryCode.slots, libraryTopic },
    tools: { ...libraryCode.tools, ...TOOLS },
    systems: () => ({ sys: new KbLibrarySystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
    knowledge: { retriever: fixedRetriever({}) },
  };
}

/** The app built from a scratch folder, registered under its own id. */
export function libraryKbApp(id: string, edits: Record<string, Edit> = {}): App {
  const dir = folder(id, edits);
  const app = defineApp(dir, codeFor(dir));
  registerApp(app);
  return app;
}

export const BASE: AnswerMap = {
  addressedToSystem: noul(0.95), intelligible: noul(0.95), utteranceComplete: noul(0.9), wantsHuman: noul(0.05),
  rephrasingLastTurn: noul(0.1), confusedByPrompt: noul(0.1), spokeAMenuNumber: noul(0.05),
  frustration: score({ none: 0.8, mild: 0.15, high: 0.05 }),
  intent: choice({ none: 0.9, other: 0.1 }),
  intentChange: choice({ answering: 0.95, adding: 0.03, replacing: 0.02 }),
  confirmsYes: noul(0.05), confirmsNo: noul(0.05),
};

export const nominated = (...topics: string[]): readonly Nomination[] => topics.map((topic, i) => ({ topic, title: topic, score: 1 - i / 10, via: 'app' }));

export interface Call {
  readonly app: App;
  readonly t: TurnContext;
  readonly sys: KbLibrarySystems;
  last: TurnResult;
}

export function call(app: App, opts: { locale?: string; today?: string; setup?: (sys: KbLibrarySystems) => void } = {}): Call {
  const systems = app.systems();
  const sys = systems.sys as KbLibrarySystems;
  opts.setup?.(sys);
  const t: TurnContext = { nowMs: 0, todayIso: opts.today ?? TODAY, thresholds: { ...DEFAULT_THRESHOLDS }, tools: { ...systems, codes: mockCodeVerifier } };
  const session = newSession(`${app.id}-call`, 0, VOICE_RELAY, ANONYMOUS, app.id);
  const last = resolve(session, startEvent({}, opts.locale), null, t);
  return { app, t, sys, last };
}

/** One spoken turn: `over` the model's answers, `topics` what retrieval nominated for the words. */
export function say(c: Call, text: string, over: AnswerMap, topics: readonly Nomination[] = []): TurnResult {
  const t: TurnContext = topics.length > 0 ? { ...c.t, knowledge: { nominated: topics } } : c.t;
  c.last = resolve(c.last.session, speechEvent(text, true), { ...BASE, ...over }, t);
  return c.last;
}

/** Asks about a topic in the opening words. */
export function ask(c: Call, topic: string): TurnResult {
  return say(c, `a question about ${topic}`, { intent: choice({ ask_library: 0.95, none: 0.05 }), libraryTopicTopic: choice({ [topic]: 0.92, none: 0.08 }) }, nominated(topic));
}

export const heard = (c: Call, r: TurnResult = c.last): string => spokenText(c.app, r.decision, r.session.locale);
export const calls = (r: TurnResult): string[] => r.gateEvents.map((e) => `${e.decision.call.tool}(${Object.entries(e.decision.call.params).map(([k, v]) => `${k}=${v}`).join(', ')}) ${e.decision.verdict}${e.summary !== null ? `: ${e.summary}` : ''}`);
export const kbRows = (r: TurnResult) => r.audit.filter((d) => d.type === 'kb_answer');

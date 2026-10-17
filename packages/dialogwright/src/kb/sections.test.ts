import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadKnowledgeFolder } from '../define/load';
import { approveDocument, placeOf } from './approval';
import { KB_FIXTURE, TODAY } from './__fixtures__/libraryKbApp';
import { defaultSectionRetriever, SectionRetriever, sectionIndexTexts, sectionOfKey, sentencesOf, summarizableSections } from './sections';
import { allIndexTexts } from './vectorIndex';
import type { KnowledgeBase } from './types';

/**
 * The sections of approved documents that may be summarized (kb.yaml documents): which ones, the
 * texts the index embeds for them, and the retriever that nominates them. On the library's knowledge
 * base, whose visitor guide no passage cites (its patron guide's sections are all cited).
 */

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch copy of the library's kb folder with summarizing on; the visitor guide approved when `approve`. */
function kbWith(options: { approve?: boolean; summarize?: 'on' | 'off' } = {}): { dir: string; kb: () => KnowledgeBase } {
  const root = mkdtempSync(join(tmpdir(), 'dialogwright-kb-sections-'));
  scratch.push(root);
  const dir = join(root, 'kb');
  cpSync(KB_FIXTURE, dir, { recursive: true });
  const kbYaml = join(dir, 'kb.yaml');
  writeFileSync(kbYaml, `${readFileSync(kbYaml, 'utf8').trimEnd()}\ndocuments:\n  summarize: ${options.summarize ?? 'on'}\n`);
  if (options.approve) {
    const place = placeOf(dir, 'kb');
    if (typeof place === 'string') throw new Error(place);
    expect(approveDocument(place, 'visitor-guide', { by: 'Riley Moreno', owner: 'Branch Services', today: TODAY })).toMatchObject({ outcome: 'approved' });
  }
  return { dir, kb: () => loadKnowledgeFolder(dir, 'en-US').kb! };
}

describe('the sections that may be summarized', () => {
  it('are none with summarizing off, and none before a person approves the document', () => {
    expect(summarizableSections(kbWith({ summarize: 'off', approve: true }).kb())).toEqual([]);
    expect(summarizableSections(kbWith().kb())).toEqual([]);
  });

  it('are an approved document\'s, but for a section a passage cites and one marked summarize: false', () => {
    const kb = kbWith({ approve: true }).kb();
    expect(summarizableSections(kb).map((s) => s.key)).toEqual(['visitor-guide#wifi', 'visitor-guide#printing', 'visitor-guide#rooms', 'visitor-guide#lost-card']);
    expect(summarizableSections(kb)[0]).toEqual({ key: 'visitor-guide#wifi', document: 'visitor-guide', documentTitle: 'Example Town Library Visitor Guide', section: 'wifi', heading: 'Wi-Fi', text: 'Every branch has free Wi-Fi. Join the network ExampleTownLibrary; no password is needed. Sessions end when the branch closes.' });
    // The patron guide's sections are each cited by a passage: never summarized, though approved documents' they would be.
    expect(summarizableSections(kb, { approved: false }).some((s) => s.document === 'patron-guide')).toBe(false);
  });

  it('are withheld once the document changes after its approval', () => {
    const { dir, kb } = kbWith({ approve: true });
    const file = join(dir, 'sources', 'visitor-guide.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('free Wi-Fi', 'fast Wi-Fi'));
    expect(summarizableSections(kb())).toEqual([]);
    expect(summarizableSections(kb(), { approved: false })).toHaveLength(4);
  });

  it('a document that says summarize: false is never summarized, approved or not', () => {
    const { dir, kb } = kbWith({ approve: true });
    const file = join(dir, 'sources', 'visitor-guide.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('provenance:', 'summarize: false\nprovenance:'));
    expect(summarizableSections(kb(), { approved: false })).toEqual([]);
  });
});

describe('their index texts', () => {
  it('are each section\'s heading and sentences, keyed by the section, in the default locale; whatever the approval', () => {
    const texts = sectionIndexTexts(kbWith().kb());
    expect(new Set(texts.map((t) => t.topic))).toEqual(new Set(['visitor-guide#wifi', 'visitor-guide#printing', 'visitor-guide#rooms', 'visitor-guide#lost-card']));
    expect(texts.filter((t) => t.topic === 'visitor-guide#wifi').map((t) => t.text).sort()).toEqual(['Every branch has free Wi-Fi.', 'Join the network ExampleTownLibrary; no password is needed.', 'Sessions end when the branch closes.', 'Wi-Fi']);
    expect(texts.every((t) => t.field === 'section' && t.locale === 'en-US')).toBe(true);
  });

  it('join the topics\' in the index with summarizing on, and are not there with it off', () => {
    const on = allIndexTexts(kbWith().kb());
    const off = allIndexTexts(kbWith({ summarize: 'off' }).kb());
    expect(on.length - off.length).toBe(sectionIndexTexts(kbWith().kb()).length);
    expect(off.some((t) => t.field === 'section')).toBe(false);
  });

  it('split a text into sentences, not at a decimal or an abbreviation in lower case', () => {
    expect(sentencesOf('It costs 2.50 dollars. Open 9 a.m. to 5 p.m. daily! Ask us? Yes.')).toEqual(['It costs 2.50 dollars.', 'Open 9 a.m. to 5 p.m. daily!', 'Ask us?', 'Yes.']);
    expect(sectionOfKey('visitor-guide#lost-card')).toEqual({ document: 'visitor-guide', section: 'lost-card' });
    expect(sectionOfKey('no-key')).toBeNull();
  });
});

describe('the section retriever', () => {
  it('nominates by keywords, best first, at most the cap, only approved sections', async () => {
    const kb = kbWith({ approve: true }).kb();
    const r = new SectionRetriever(kb, { cap: 2 });
    expect(r.id).toBe('sections:keyword');
    const got = await r.nominate({ text: 'how much does it cost to print in color', locale: 'en-US', todayIso: TODAY });
    expect(got[0]).toMatchObject({ topic: 'visitor-guide#printing', title: 'Printing and copies', via: 'keyword' });
    expect(got.length).toBeLessThanOrEqual(2);
    expect(await new SectionRetriever(kbWith().kb()).nominate({ text: 'printing', locale: 'en-US', todayIso: TODAY })).toEqual([]);
  });

  it('is the default with summarizing on and a section approved; none otherwise', () => {
    expect(defaultSectionRetriever(kbWith({ approve: true }).kb(), undefined)).toBeInstanceOf(SectionRetriever);
    expect(defaultSectionRetriever(kbWith().kb(), undefined)).toBeNull();
    expect(defaultSectionRetriever(kbWith({ approve: true, summarize: 'off' }).kb(), undefined)).toBeNull();
  });
});

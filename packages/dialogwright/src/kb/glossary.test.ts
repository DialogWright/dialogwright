import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadKnowledgeFolder } from '../define/load';
import { approveDocument, placeOf } from './approval';
import { KB_FIXTURE, TODAY, VISITOR_GUIDE } from './__fixtures__/libraryKbApp';
import { applyGlossary, glossaryOf } from './glossary';
import { sectionIndexTexts, summarizableSections } from './sections';

/**
 * The glossary (kb/glossary.yaml): the words said in place of a document's jargon, in the sections
 * answered from by summarizing, never in a passage; and a document's approval covering its sections as
 * replaced, so a change that reaches one withholds it until a person approves it again.
 */

describe('a glossary', () => {
  const glossary = glossaryOf({ CYD: 'calendar year deductible', 'Participating Provider': 'in-network provider', 'Non-Participating Provider': 'out-of-network provider', PCP: 'primary care physician' });

  it('says each term in its words, whole words and phrases only, its case as written, the longest first, in one pass', () => {
    expect(applyGlossary('When using a Non-Participating Provider, CYD applies; a Participating Provider: 20%.', glossary)).toBe('When using a out-of-network provider, calendar year deductible applies; a in-network provider: 20%.');
    expect(applyGlossary('PCPs and cyd and CYDs are not terms here; see your PCP.', glossary)).toBe('PCPs and cyd and CYDs are not terms here; see your primary care physician.');
    // What a replacement says is never replaced again.
    expect(applyGlossary('PCP', glossaryOf({ PCP: 'primary care physician (PCP)' }))).toBe('primary care physician (PCP)');
    expect(applyGlossary('CYD', undefined)).toBe('CYD');
  });
});

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('a knowledge base with a glossary', () => {
  function kbWith(glossary?: string): { dir: string; load: () => ReturnType<typeof loadKnowledgeFolder> } {
    const root = mkdtempSync(join(tmpdir(), 'dialogwright-kb-glossary-'));
    scratch.push(root);
    const dir = join(root, 'kb');
    cpSync(KB_FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, 'sources', 'visitor-guide.yaml'), VISITOR_GUIDE);
    const kbYaml = join(dir, 'kb.yaml');
    writeFileSync(kbYaml, `${readFileSync(kbYaml, 'utf8').trimEnd()}\ndocuments:\n  summarize: on\n`);
    if (glossary !== undefined) writeFileSync(join(dir, 'glossary.yaml'), glossary);
    return { dir, load: () => loadKnowledgeFolder(dir, 'en-US') };
  }
  const approve = (dir: string) => {
    const place = placeOf(dir, 'kb');
    if (typeof place === 'string') throw new Error(place);
    expect(approveDocument(place, 'visitor-guide', { by: 'Riley Moreno', owner: 'Branch Services', today: TODAY })).toMatchObject({ outcome: 'approved' });
  };

  it('answers from its sections in the glossary\'s words, and indexes them so; the source keeps the document\'s own', () => {
    const { dir, load } = kbWith('Wi-Fi: wireless internet\nExampleTownLibrary: Example Town Library\n');
    approve(dir);
    const kb = load().kb!;
    const wifi = summarizableSections(kb).find((s) => s.section === 'wifi')!;
    expect(wifi).toMatchObject({ heading: 'wireless internet', text: 'Every branch has free wireless internet. Join the network Example Town Library; no password is needed. Sessions end when the branch closes.' });
    expect(sectionIndexTexts(kb).some((t) => t.text === 'wireless internet')).toBe(true);
    expect(kb.sources['visitor-guide']!.sections['wifi']!.text).toContain('free Wi-Fi');
    // A passage is said as approved: the patron guide's passages keep their words.
    expect(Object.values(kb.passages).every((p) => !p.answer.includes('wireless internet'))).toBe(true);
  });

  it('has its documents approved as replaced: a change of the glossary that reaches one withholds it; one that reaches none does not; none at all changes no hash', () => {
    const plain = kbWith();
    const before = plain.load().kb!.sources['visitor-guide']!.hash;
    expect(kbWith('Unused term: nothing\n').load().kb!.sources['visitor-guide']!.hash).toBe(before);
    const { dir, load } = kbWith('Wi-Fi: wireless internet\n');
    approve(dir);
    expect(load().kb!.sources['visitor-guide']!.freshness).toBe('fresh');
    writeFileSync(join(dir, 'glossary.yaml'), 'Wi-Fi: wireless network\n');
    expect(load().kb!.sources['visitor-guide']!.freshness).toBe('edited');
    expect(summarizableSections(load().kb!)).toEqual([]);
  });
});

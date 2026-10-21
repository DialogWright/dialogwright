import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { planSources } from './write';

/** A source file as a person left it: the document applied to one plan and approved, a section kept from summaries, with comments. */
const BEFORE = `document: Example Plan Guide
title: Example Plan, Basic (2026)
provenance:
  file: docs-src/guide.pdf
  retrieved: 2026-09-01
applies:
  plan: [basic]
sections:
  fees:
    heading: Fees
    text: A visit costs 10 dollars.
  example:
    heading: An example
    # Its amounts are examples only: never summarized for a caller.
    summarize: false
    text: Say a visit costs 99 dollars.
  gone:
    heading: Gone
    summarize: false
    text: This section is no longer in the document.
approval:
  by: Example Approver
  owner: Example Team
  on: 2026-09-02
  hash: 0123456789ab
`;

describe('a source file written again', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps what a person wrote into it, with its comments: the document\'s title, applies and approval, and a section\'s summarize while the section is there', () => {
    dir = mkdtempSync(join(tmpdir(), 'kb-author-write-'));
    const sources = join(dir, 'kb', 'sources');
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, 'guide.yaml'), BEFORE);
    const [change] = planSources(
      [{ provenance: { file: 'docs-src/guide.pdf' }, title: 'Example Plan Guide', id: 'guide', sections: [
        { id: 'fees', heading: 'Fees', text: 'A visit costs 12 dollars.' },
        { id: 'example', heading: 'An example', text: 'Say a visit costs 99 dollars.' },
        { id: 'new', heading: 'New', text: 'A section the document gained.' },
      ] }],
      { sourcesDir: sources, today: '2026-10-19' },
    );
    expect(change!.status).toBe('changed');
    const yaml = change!.yaml!;
    const data = parse(yaml) as Record<string, unknown> & { sections: Record<string, Record<string, unknown>> };
    expect(data.applies).toEqual({ plan: ['basic'] });
    // A person's title is kept beside the one read from the document, which reading writes again.
    expect(data.title).toBe('Example Plan, Basic (2026)');
    expect(data.document).toBe('Example Plan Guide');
    // Kept as it was: its hash no longer matches the text, so the engine reads it as stale until a person approves again.
    expect(data.approval).toEqual({ by: 'Example Approver', owner: 'Example Team', on: '2026-09-02', hash: '0123456789ab' });
    expect(data.sections.example).toEqual({ heading: 'An example', summarize: false, text: 'Say a visit costs 99 dollars.' });
    expect(yaml).toContain('    # Its amounts are examples only: never summarized for a caller.\n    summarize: false\n');
    expect(data.sections.fees).toEqual({ heading: 'Fees', text: 'A visit costs 12 dollars.' });
    expect(data.sections.new).toEqual({ heading: 'New', text: 'A section the document gained.' });
    expect(Object.keys(data.sections)).toEqual(['fees', 'example', 'new']);
    expect((data.provenance as Record<string, unknown>).retrieved).toBe('2026-10-19');
  });
});

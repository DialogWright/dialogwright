import { describe, expect, it } from 'vitest';
import { sourcesField, sourcesText } from './sources';
import { DEFAULT_STRINGS } from './strings';

describe('where an answer comes from', () => {
  it('keeps only well-formed sources from the wire: a title, and a heading and a whole page number where given', () => {
    expect(sourcesField(undefined)).toEqual({});
    expect(sourcesField([{ document: '' }, null, 'x', { document: 3 }])).toEqual({});
    expect(sourcesField([{ document: 'Guide', section: ' ', page: 0 }, { document: 'Guide', section: 'Fees', page: 2.5 }, { document: 'Guide', section: 'Hours', page: 4 }])).toEqual({
      sources: [{ document: 'Guide' }, { document: 'Guide', section: 'Fees' }, { document: 'Guide', section: 'Hours', page: 4 }],
    });
  });

  it('says one source, or several once each, in the site\'s words', () => {
    expect(sourcesText([{ document: 'Guide', section: 'Fees', page: 3 }], DEFAULT_STRINGS)).toBe('Source: Guide · Fees · p. 3');
    expect(sourcesText([{ document: 'Guide' }, { document: 'Guide' }, { document: 'Map' }], { source: 'Fuente:', sources: 'Fuentes:', page: 'pág.' })).toBe('Fuentes: Guide; Map');
  });
});

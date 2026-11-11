import { describe, expect, it } from 'vitest';
import { fakeTextProvider, TextKeys } from '../../texts/record';
import type { TextRecord } from '../../texts/types';
import { converseTexts } from './texts';

describe('converseTexts', () => {
  it('is null with no sender', () => {
    expect(converseTexts(null, () => {})).toBeNull();
  });
  it('sends from the turn\'s number, records each text by its last four, and sends a key once', async () => {
    const provider = fakeTextProvider();
    const records: TextRecord[] = [];
    const t = converseTexts({ provider, from: '+15555550100', keys: new TextKeys() }, (r) => records.push(r))!;
    await t.send({ to: '+15555550177', body: 'See you Friday', key: 'k' });
    const again = await t.send({ to: '+15555550177', body: 'See you Friday', key: 'k' });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.from).toBe('+15555550100');
    expect(again.repeat).toBe(true);
    expect(records.map((r) => r.number)).toEqual(['...0177', '...0177']);
    expect(records[0]!.bodyLength).toBe(14);
  });
});

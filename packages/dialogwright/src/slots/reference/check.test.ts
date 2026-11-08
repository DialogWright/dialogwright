import { describe, expect, it } from 'vitest';
import { buildSlot } from '../defineSlot';
import { referenceType } from './index';

describe('reference check', () => {
  it('is unsupported: what the slot holds is chosen among the app\'s own data, never cited by an agent', () => {
    const example = referenceType.examples[0]!;
    const built = buildSlot(example.slot, { type: 'reference', ...example.config }, {});
    if (!built.ok) throw new Error('the example does not build');
    const check = built.spec.check!;
    expect(check('x', 'x', 'x', { today: '2026-09-18' })).toEqual({ ok: false, reason: 'unsupported' });
    expect(check('x', 'y', 'x', { today: '2026-09-18', locale: 'es' })).toEqual({ ok: false, reason: 'unsupported' });
  });
});

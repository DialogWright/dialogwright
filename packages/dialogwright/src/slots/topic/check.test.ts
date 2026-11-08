import { describe, expect, it } from 'vitest';
import { buildSlot } from '../defineSlot';
import { topicType } from './index';

describe('topic check', () => {
  it('is unsupported: what the slot holds is chosen among the app\'s own data, never cited by an agent', () => {
    const example = topicType.examples[0]!;
    const built = buildSlot(example.slot, { type: 'topic', ...example.config }, {});
    if (!built.ok) throw new Error('the example does not build');
    const check = built.spec.check!;
    expect(check('x', 'x', 'x', { today: '2026-09-18' })).toEqual({ ok: false, reason: 'unsupported' });
    expect(check('x', 'y', 'x', { today: '2026-09-18', locale: 'es' })).toEqual({ ok: false, reason: 'unsupported' });
  });
});

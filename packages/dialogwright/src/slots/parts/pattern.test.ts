import { describe, expect, it } from 'vitest';
import { repeatsARepeat } from './pattern';

describe('repeatsARepeat', () => {
  it('finds a group repeated without bound around a repeat without bound', () => {
    for (const source of ['^(\\d+)+5$', '(\\d*)*', '(?:a+b)*', '((\\d)+){2,}', '(x(\\d+))+', '^(\\d+)+$']) expect(repeatsARepeat(source), source).toBe(true);
  });

  it('leaves alone a repeat of a fixed group, a bounded repeat, an escaped bracket and a class', () => {
    for (const source of ['^\\d{8}$', '^9\\d{9}$', '[A-Za-z0-9_-]+', '(\\d{4})+', '(\\d+){2}', '(\\d+)?', '\\(\\d+\\)+', '[(+]+', '(?:\\d{3}-)+\\d{4}', '\\d+5']) expect(repeatsARepeat(source), source).toBe(false);
  });
});

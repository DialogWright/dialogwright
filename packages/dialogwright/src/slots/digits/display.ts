import type { DigitsOptions } from './options';

/**
 * How a digits slot's value is said: in `group`s of those sizes joined by a space ("5550 7788"), the
 * last group taking any digits left over; all together without `group`. The same in every locale.
 * The fill, the keypad and the spec's `display` all use this one function.
 */
export function digitsDisplay(o: Pick<DigitsOptions, 'group'>): (value: string, locale?: string) => string {
  const { group } = o;
  if (group === undefined) return (value) => value;
  return (value) => {
    const parts: string[] = [];
    let at = 0;
    group.forEach((size, i) => {
      const part = i === group.length - 1 ? value.slice(at) : value.slice(at, at + size);
      if (part !== '') parts.push(part);
      at += size;
    });
    return parts.join(' ');
  };
}

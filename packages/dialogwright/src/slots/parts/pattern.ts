/**
 * Guards for the regular expressions an app writes into a slot's options (a digits `mask`, a record
 * `keyPattern`): a group that repeats a repeat (`(\d+)+`) can backtrack for minutes on a string that
 * almost matches, so it is refused when the slot is defined, and every string is capped in length
 * before a pattern is tried on it.
 */

/** The longest digits a digits slot tries its mask on: as long as its longest `length`. Longer is no value. */
export const MAX_DIGITS = 40;

/** The longest key a record slot tries its `keyPattern` on. Longer is no key. */
export const MAX_KEY_LENGTH = 64;

/** Whether the pattern source has an unbounded repeat (`+`, `*`, `{n,}`) at `i`. */
function unboundedAt(source: string, i: number): boolean {
  const c = source[i];
  if (c === '+' || c === '*') return true;
  if (c !== '{') return false;
  const m = /^\{\d+,(\d*)\}/.exec(source.slice(i));
  return m !== null && m[1] === '';
}

/**
 * Whether `source` repeats, without bound, a group that itself repeats without bound (`(\d+)+`,
 * `(?:a*b*)*`, `((\d)+){2,}`): the classic shape of a pattern whose failures take exponential time.
 * A heuristic: alternations of overlapping branches (`(a|aa)+`) are not caught, which is why inputs
 * are also capped (MAX_DIGITS, MAX_KEY_LENGTH).
 */
export function repeatsARepeat(source: string): boolean {
  // For each open group: whether something inside it repeats without bound.
  const open: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(') open.push(false);
    else if (c === ')') {
      const inner = open.pop() ?? false;
      const repeated = unboundedAt(source, i + 1);
      if (inner && repeated) return true;
      if (open.length > 0 && (inner || repeated)) open[open.length - 1] = true;
    } else if (open.length > 0 && unboundedAt(source, i)) open[open.length - 1] = true;
  }
  return false;
}

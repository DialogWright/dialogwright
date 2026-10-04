import { relative } from 'node:path';

/** The command line's small helpers, shared by the commands. */

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Options `--name value` (some repeatable), flags, and the positional arguments; or what is wrong with the command line. */
export function parseArgs(
  args: readonly string[],
  known: { values?: readonly string[]; lists?: readonly string[]; flags?: readonly string[] },
): { positional: string[]; values: Record<string, string>; lists: Record<string, string[]>; flags: Set<string> } | string {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = Object.fromEntries((known.lists ?? []).map((l) => [l, []]));
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (known.flags?.includes(a)) flags.add(a);
    else if (known.values?.includes(a) || known.lists?.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
      if (a in lists) lists[a]!.push(v);
      else values[a] = v;
      i += 1;
    } else if (a.startsWith('-')) return `${a} is not an option`;
    else positional.push(a);
  }
  return { positional, values, lists, flags };
}

/** A path as a command says it: from where it was run when under it. */
export function shown(cwd: string, p: string): string {
  const rel = relative(cwd, p);
  return rel === '' ? '.' : rel.startsWith('..') ? p : rel;
}

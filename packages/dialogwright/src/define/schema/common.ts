import { z } from 'zod';

/**
 * Pieces every file schema shares: the shapes of ids and names, and the fix an author is told when
 * one is wrong.
 *
 * A schema's own messages say what is wrong ("must start with a letter ..."); the loader (../load.ts)
 * puts the offending value in front of them and a fix after. For a pattern the fix lives here, next
 * to the pattern, so the two cannot drift apart.
 */

/** The fix to show for each registered pattern, keyed by the regular expression as zod reports it (`String(re)`). */
const PATTERN_FIXES = new Map<string, string>();

/** The fix registered for a pattern an issue names, if any (the loader reads this). */
export function fixForPattern(pattern: string): string | undefined {
  return PATTERN_FIXES.get(pattern);
}

/** A string that must match `re`: `message` says what is wrong with one that does not, `fix` what to write instead. */
export function matching(re: RegExp, message: string, fix: string) {
  PATTERN_FIXES.set(String(re), fix);
  return z.string().regex(re, { error: message });
}

/** An id that code refers to (a slot, form, intent, tool, prompt or param): a plain word, usable as an object key in TypeScript. */
export const identifier = () =>
  matching(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    'is not a valid id: it must start with a letter and use only letters, digits and underscores',
    'rename it using only letters, digits and underscores, starting with a letter (for example "ask_name" or "patientId")',
  );

/** A name that is only ever a label or a code (a purpose, a role, a rule, a handoff reason, an audit row type): hyphens and dots are allowed too. */
export const name = () =>
  matching(
    /^[A-Za-z][A-Za-z0-9_.-]*$/,
    'is not a valid name: it must start with a letter and use only letters, digits, underscores, hyphens and dots',
    'rename it using only letters, digits, underscores, hyphens and dots, starting with a letter (for example "needs-human")',
  );

/** A string with something in it: an empty one is always a mistake in these files. */
export const text = () => z.string().min(1, { error: 'must not be empty' });

/** The identity level a call needs: 0 anonymous, 1 the factors matched, 2 the factors and the one-time code. */
export const level = () => z.literal([0, 1, 2]);

/**
 * A refinement that runs even when the value has other problems, so one pass reports everything
 * (zod skips a refinement by default once the value it checks has an error inside it). Because the
 * value may then be malformed, `fn` takes `unknown` and must check what it reads.
 */
export function checkAlways(fn: (value: unknown, ctx: z.core.$RefinementCtx) => void): z.core.$ZodCheck<any> {
  const check = z.superRefine(fn as (value: never, ctx: z.core.$RefinementCtx) => void);
  check._zod.def.when = () => true;
  return check as unknown as z.core.$ZodCheck<any>;
}

/** A list whose entries must differ; the issue lands on the second copy. */
export function unique<T extends z.ZodType<string>>(item: T, what: string) {
  return z.array(item).check(
    checkAlways((items, ctx) => {
      if (!Array.isArray(items)) return;
      const seen = new Set<unknown>();
      items.forEach((value, i) => {
        if (typeof value === 'string' && seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [i],
            message: `${what} "${value}" is listed twice`,
            params: { fix: `delete one of the two "${value}" entries` },
          });
        }
        seen.add(value);
      });
    }),
  );
}

/** A map from a key of one shape to a text, the common shape of every wording table. */
export const textMap = (key: z.ZodType<string> = name()) => z.record(key, text());

/** The kinds of file an app folder holds; each has a schema (./index.ts) and a JSON Schema (../../../schemas). */
export const FILE_KINDS = ['app', 'intents', 'forms', 'prompts', 'policy', 'identity'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

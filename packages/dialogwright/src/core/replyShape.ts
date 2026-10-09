/**
 * Small checks a tool writes its reply's shape with (ToolDef.check): a downstream system's reply is
 * untrusted, and a field a line says (a reference, a name, a date, an amount) is held to the shape
 * the line needs, so text with instructions in it is never said, and a value the app's code would
 * trip over goes to a person instead. Each returns a check: a function of the value, true when it
 * fits. They compose: `replyShape.object({ ref: replyShape.digits(4), item: replyShape.text() })`.
 */
export type ReplyCheck = (value: unknown) => boolean;

/** A word of short text: letters and digits of any script, with an apostrophe, a hyphen, a slash or a period inside it. */
const WORD = String.raw`[\p{L}\p{M}\p{N}]+(?:['’./-][\p{L}\p{M}\p{N}]+)*`;
/** Words with one space or a comma and a space between them, and the `#` of a unit number before one: an address line, an item, a name, never a sentence. */
const TEXT = new RegExp(`^#?${WORD}(?:,? #?${WORD})*$`, 'u');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const replyShape = {
  /**
   * Short plain text: words (letters and digits of any script, an apostrophe, a hyphen, a slash or a
   * period inside a word), one space or a comma between them; no sentence's end, no colon, no line
   * break; at most `words` words (default 8) and `chars` characters (default 80).
   */
  text(opts: { words?: number; chars?: number } = {}): ReplyCheck {
    const words = opts.words ?? 8;
    const chars = opts.chars ?? 80;
    return (v) => typeof v === 'string' && v.length <= chars && TEXT.test(v) && v.split(' ').length <= words;
  },
  /** Digits only: exactly `length` of them, or `min` to `max` (default: one or more). */
  digits(length?: number | { min: number; max: number }): ReplyCheck {
    const [min, max] = length === undefined ? [1, Infinity] : typeof length === 'number' ? [length, length] : [length.min, length.max];
    return (v) => typeof v === 'string' && /^\d+$/.test(v) && v.length >= min && v.length <= max;
  },
  /** Letters and digits only (a reference such as OT401), `min` to `max` characters (default 1 to 20). */
  code(opts: { min?: number; max?: number } = {}): ReplyCheck {
    return (v) => typeof v === 'string' && /^[A-Za-z0-9]+$/.test(v) && v.length >= (opts.min ?? 1) && v.length <= (opts.max ?? 20);
  },
  /** A calendar date written yyyy-mm-dd, one that exists. */
  isoDate(): ReplyCheck {
    return (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
  },
  /** An amount written as a plain decimal: digits, and at most two after a point ("240.00"). */
  amount(): ReplyCheck {
    return (v) => typeof v === 'string' && /^\d{1,9}(?:\.\d{1,2})?$/.test(v);
  },
  /** A finite number, between `min` and `max` where given. */
  number(opts: { min?: number; max?: number } = {}): ReplyCheck {
    return (v) => typeof v === 'number' && Number.isFinite(v) && v >= (opts.min ?? -Infinity) && v <= (opts.max ?? Infinity);
  },
  boolean(): ReplyCheck {
    return (v) => typeof v === 'boolean';
  },
  /** One of `values`, exactly. */
  oneOf(values: readonly unknown[]): ReplyCheck {
    return (v) => values.includes(v);
  },
  /** `check`, or null. */
  nullable(check: ReplyCheck): ReplyCheck {
    return (v) => v === null || check(v);
  },
  /** A list each of whose items passes `item`. */
  list(item: ReplyCheck): ReplyCheck {
    return (v) => Array.isArray(v) && v.every(item);
  },
  /**
   * An object each named field of which passes its check (a field the object does not have is
   * undefined to its check); fields not named are not checked, so name every field a line says or a
   * call is made from.
   */
  object(fields: Readonly<Record<string, ReplyCheck>>): ReplyCheck {
    return (v) => isObject(v) && Object.entries(fields).every(([k, check]) => check(Object.hasOwn(v, k) ? v[k] : undefined));
  },
  /** Every one of `checks`. */
  all(...checks: ReplyCheck[]): ReplyCheck {
    return (v) => checks.every((c) => c(v));
  },
  /** Any one of `checks`. */
  any(...checks: ReplyCheck[]): ReplyCheck {
    return (v) => checks.some((c) => c(v));
  },
} as const;

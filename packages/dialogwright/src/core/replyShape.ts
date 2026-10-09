/**
 * Small checks a tool writes its reply's shape with (ToolDef.check): a downstream system's reply is
 * untrusted, and a field a line says or a call is made from (a reference, a name, a date, an amount)
 * is held to the shape the line needs, so a value the app's code would trip over, or text that is not
 * the field's kind of value, goes to a person instead. A check bounds a field's shape; it does not
 * detect instructions: four plain words pass `text()`. So use a closed form wherever the field has one
 * (`oneOf`, `digits`, `code`, `isoDate`, `amount`); a field that is truly free text and said (a
 * person's first name, an item's description) is said only in its own place in a fixed line. Each returns a check: a function of the value, true when it
 * fits. They compose: `replyShape.object({ ref: replyShape.digits(4), item: replyShape.text() })`.
 */
export type ReplyCheck = (value: unknown) => boolean;

/**
 * A word of short text: letters and digits of any script, with an apostrophe, a hyphen, a slash, a
 * period, a middle dot or a zero-width joiner or non-joiner inside it (as a name may be written); a word
 * of letters alone may end in one period, an abbreviation's ("St.", "Apt.").
 */
const WORD = String.raw`(?:[\p{L}\p{M}\p{N}]+(?:['’./\u00B7\u200C\u200D-][\p{L}\p{M}\p{N}]+)*|[\p{L}\p{M}]+(?:['’.\u00B7\u200C\u200D-][\p{L}\p{M}]+)*\.)`;
/** Words with one space or a comma and a space between them, and the `#` of a unit number before one: an address line, an item, a name, never a sentence. */
const TEXT = new RegExp(`^#?${WORD}(?:,? #?${WORD})*$`, 'u');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const replyShape = {
  /**
   * Short plain text: words (letters and digits of any script, an apostrophe, a hyphen, a slash or a
   * period inside a word; a word of letters may end in an abbreviation's period), one space or a comma
   * between them; no colon, no question or exclamation mark, no line break; at most `words` words
   * (default 8) and `chars` characters (default 80). It bounds a field's shape and length: it does not
   * tell instructions from a name (four plain words pass). Use a closed form where the field has one.
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
  /** Letters and digits with a hyphen between (a reference such as OT401 or A-1001), `min` to `max` characters (default 1 to 20). */
  code(opts: { min?: number; max?: number } = {}): ReplyCheck {
    return (v) => typeof v === 'string' && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(v) && v.length >= (opts.min ?? 1) && v.length <= (opts.max ?? 20);
  },
  /** A calendar date written yyyy-mm-dd, one that exists. */
  isoDate(): ReplyCheck {
    return (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
  },
  /** An amount written as a plain decimal: digits, and at most two after a point ("240.00"); with `credit`, a minus first too ("-12.50", a balance in the caller's favour). */
  amount(opts: { credit?: boolean } = {}): ReplyCheck {
    const shape = opts.credit === true ? /^-?\d{1,9}(?:\.\d{1,2})?$/ : /^\d{1,9}(?:\.\d{1,2})?$/;
    return (v) => typeof v === 'string' && shape.test(v);
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

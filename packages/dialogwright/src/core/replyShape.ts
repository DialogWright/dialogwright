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

/**
 * What a check made by replyShape is, kept beside it (a function cannot be read): its kind, and for a
 * composite the checks it is made of. A check written by hand has none.
 */
export type ReplyShapeTag =
  | { readonly kind: 'text' | 'digits' | 'code' | 'isoDate' | 'amount' | 'number' | 'boolean' | 'oneOf' }
  | { readonly kind: 'nullable' | 'list'; readonly of: ReplyCheck }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ReplyCheck>> }
  | { readonly kind: 'all' | 'any'; readonly of: readonly ReplyCheck[] };

const TAGS = new WeakMap<ReplyCheck, ReplyShapeTag>();

function tag(check: ReplyCheck, shape: ReplyShapeTag): ReplyCheck {
  TAGS.set(check, shape);
  return check;
}

/** What `check` is, where replyShape made it; undefined for a check written by hand (or anything else). */
export function shapeOf(check: unknown): ReplyShapeTag | undefined {
  return typeof check === 'function' ? TAGS.get(check as ReplyCheck) : undefined;
}

/** The kinds of value a closed form allows (a value from a set the app wrote, a number of a fixed shape, a day, yes or no): never free text. */
const CLOSED_KINDS: ReadonlySet<ReplyShapeTag['kind']> = new Set(['digits', 'code', 'isoDate', 'amount', 'number', 'boolean', 'oneOf']);

/**
 * Where `check` is not a closed form, the first place it is not, in words ("`windows[]` is free text
 * (replyShape.text())"); null where it is built only of closed forms (oneOf, digits, code, isoDate,
 * amount, number, boolean, and nullable, list, object, all and any of them). A check written by hand is
 * never known to be closed: the engine cannot read a function. This is what lets a tool's result be shown
 * to a model (business.yaml's `sees`: the agent-mode design's decision 2).
 */
export function openPart(check: unknown, at = ''): string | null {
  const where = at === '' ? 'the reply' : `\`${at}\``;
  const shape = shapeOf(check);
  if (shape === undefined) return `${where} is checked by a function written by hand, which the engine cannot read`;
  if (shape.kind === 'text') return `${where} is free text (replyShape.text())`;
  if (CLOSED_KINDS.has(shape.kind)) return null;
  switch (shape.kind) {
    case 'nullable':
      return openPart(shape.of, at);
    case 'list':
      return openPart(shape.of, `${at}[]`);
    case 'object': {
      const fields = Object.entries(shape.fields);
      if (fields.length === 0) return `${where} is an object with no field named, so nothing of it is checked`;
      for (const [k, c] of fields) {
        const open = openPart(c, at === '' ? k : `${at}.${k}`);
        if (open !== null) return open;
      }
      return null;
    }
    case 'all':
    case 'any': {
      if (shape.of.length === 0) return `${where} is checked by ${shape.kind}() of nothing`;
      for (const c of shape.of) {
        const open = openPart(c, at);
        if (open !== null) return open;
      }
      return null;
    }
    default:
      return `${where} is of a shape the engine does not know`;
  }
}

/**
 * The fields `check` names, each by its path (`day`, `windows[].name`): what a model is shown of a reply
 * (namedPart). Empty for a check of a value with no fields of its own (a date, a list of options).
 */
export function namedFields(check: unknown, at = ''): string[] {
  const shape = shapeOf(check);
  if (shape === undefined) return [];
  switch (shape.kind) {
    case 'nullable':
      return namedFields(shape.of, at);
    case 'list':
      return namedFields(shape.of, `${at}[]`);
    case 'object':
      return Object.entries(shape.fields).flatMap(([k, c]) => {
        const path = at === '' ? k : `${at}.${k}`;
        const inner = namedFields(c, path);
        return inner.length > 0 ? inner : [path];
      });
    case 'all':
    case 'any':
      return [...new Set(shape.of.flatMap((c) => namedFields(c, at)))];
    default:
      return [];
  }
}

/**
 * What of `value` (a reply that passed `check`) its check names: an object's named fields only (each as
 * its own check names it), a list's items so, and anything else as it is; undefined where `check` is not
 * replyShape's. What a model is shown of a tool's result (business.yaml's `sees`): a field the check
 * does not name is never checked, so never shown.
 */
export function namedPart(check: unknown, value: unknown): unknown {
  const shape = shapeOf(check);
  if (shape === undefined) return undefined;
  switch (shape.kind) {
    case 'nullable':
      return value === null ? null : namedPart(shape.of, value);
    case 'list':
      return Array.isArray(value) ? value.map((item) => namedPart(shape.of, item)) : undefined;
    case 'object': {
      if (!isObject(value)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(shape.fields)) if (Object.hasOwn(value, k)) out[k] = namedPart(c, value[k]);
      return out;
    }
    case 'all':
      // Every check holds: of an object, the fields any of them names.
      return isObject(value) ? Object.assign({}, ...shape.of.map((c) => namedPart(c, value)).filter(isObject)) : namedPart(shape.of[0], value);
    case 'any': {
      const branch = shape.of.find((c) => c(value));
      return branch === undefined ? undefined : namedPart(branch, value);
    }
    default:
      return value;
  }
}

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
    return tag((v) => typeof v === 'string' && v.length <= chars && TEXT.test(v) && v.split(' ').length <= words, { kind: 'text' });
  },
  /** Digits only: exactly `length` of them, or `min` to `max` (default: one or more). */
  digits(length?: number | { min: number; max: number }): ReplyCheck {
    const [min, max] = length === undefined ? [1, Infinity] : typeof length === 'number' ? [length, length] : [length.min, length.max];
    return tag((v) => typeof v === 'string' && /^\d+$/.test(v) && v.length >= min && v.length <= max, { kind: 'digits' });
  },
  /** Letters and digits with a hyphen between (a reference such as OT401 or A-1001), `min` to `max` characters (default 1 to 20). */
  code(opts: { min?: number; max?: number } = {}): ReplyCheck {
    return tag((v) => typeof v === 'string' && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(v) && v.length >= (opts.min ?? 1) && v.length <= (opts.max ?? 20), { kind: 'code' });
  },
  /** A calendar date written yyyy-mm-dd, one that exists. */
  isoDate(): ReplyCheck {
    return tag((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), { kind: 'isoDate' });
  },
  /** An amount written as a plain decimal: digits, and at most two after a point ("240.00"); with `credit`, a minus first too ("-12.50", a balance in the caller's favour). */
  amount(opts: { credit?: boolean } = {}): ReplyCheck {
    const shape = opts.credit === true ? /^-?\d{1,9}(?:\.\d{1,2})?$/ : /^\d{1,9}(?:\.\d{1,2})?$/;
    return tag((v) => typeof v === 'string' && shape.test(v), { kind: 'amount' });
  },
  /** A finite number, between `min` and `max` where given. */
  number(opts: { min?: number; max?: number } = {}): ReplyCheck {
    return tag((v) => typeof v === 'number' && Number.isFinite(v) && v >= (opts.min ?? -Infinity) && v <= (opts.max ?? Infinity), { kind: 'number' });
  },
  boolean(): ReplyCheck {
    return tag((v) => typeof v === 'boolean', { kind: 'boolean' });
  },
  /** One of `values`, exactly. */
  oneOf(values: readonly unknown[]): ReplyCheck {
    return tag((v) => values.includes(v), { kind: 'oneOf' });
  },
  /** `check`, or null. */
  nullable(check: ReplyCheck): ReplyCheck {
    return tag((v) => v === null || check(v), { kind: 'nullable', of: check });
  },
  /** A list each of whose items passes `item`. */
  list(item: ReplyCheck): ReplyCheck {
    return tag((v) => Array.isArray(v) && v.every(item), { kind: 'list', of: item });
  },
  /**
   * An object each named field of which passes its check (a field the object does not have is
   * undefined to its check); fields not named are not checked, so name every field a line says or a
   * call is made from.
   */
  object(fields: Readonly<Record<string, ReplyCheck>>): ReplyCheck {
    return tag((v) => isObject(v) && Object.entries(fields).every(([k, check]) => check(Object.hasOwn(v, k) ? v[k] : undefined)), { kind: 'object', fields: { ...fields } });
  },
  /** Every one of `checks`. */
  all(...checks: ReplyCheck[]): ReplyCheck {
    return tag((v) => checks.every((c) => c(v)), { kind: 'all', of: [...checks] });
  },
  /** Any one of `checks`. */
  any(...checks: ReplyCheck[]): ReplyCheck {
    return tag((v) => checks.some((c) => c(v)), { kind: 'any', of: [...checks] });
  },
} as const;

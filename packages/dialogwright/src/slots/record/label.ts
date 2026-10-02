import { describeDay } from '../../core/extract/date';

/**
 * A record slot's label templates: `{field}` is a field of the record, `{key}` the record's key, and
 * `{field|filter}` the field through one of a few fixed filters. Nothing else is evaluated: no
 * expressions, no code, no other syntax. A brace that is not around a name (and an optional filter)
 * is kept as written.
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)(?:\|([A-Za-z]+))?\}/g;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The filters a label may use, by name. Each takes the field as text and returns text; one that cannot read it returns it as it is. */
export const LABEL_FILTERS: Readonly<Record<string, (value: string) => string>> = Object.freeze({
  /** An ISO date ("2026-09-18") as a day ("Friday, September 18"). */
  day: (value: string) => (ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? describeDay(value) : value),
});

/** What is wrong with a label template: a filter it does not have, or (with `only`) a name it may not use. */
export function checkLabelTemplate(template: string, only?: readonly string[]): string[] {
  const problems: string[] = [];
  for (const [, name, filter] of template.matchAll(PLACEHOLDER)) {
    if (filter !== undefined && !Object.hasOwn(LABEL_FILTERS, filter)) problems.push(`{${name}|${filter}} uses the filter "${filter}", which is not one of ${Object.keys(LABEL_FILTERS).map((f) => `"${f}"`).join(', ')}`);
    if (only && !only.includes(name!)) problems.push(`{${name}${filter ? `|${filter}` : ''}} is not one of its variables; it may use ${only.map((v) => `{${v}}`).join(', ')}`);
  }
  return problems;
}

/** A field's value as text: a string as it is, a number or a boolean written out, anything else (absent, a list, an object) empty. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * `template` filled from `fields`, with `{key}` the key given. A field the record lacks is empty.
 * The template's filters were checked when the slot was built (checkLabelTemplate).
 */
export function renderLabel(template: string, key: string, fields: Readonly<Record<string, unknown>>): string {
  return template.replace(PLACEHOLDER, (_, name: string, filter: string | undefined) => {
    const raw = name === 'key' ? key : Object.hasOwn(fields, name) ? textOf(fields[name]) : '';
    return filter === undefined ? raw : LABEL_FILTERS[filter]!(raw);
  });
}

/**
 * A topic slot's criterion template: `{title}` is the nominated topic's title, `{topic}` its id, and
 * `{title|lower}` the title in lower case. Nothing else is evaluated: no expressions, no code, no
 * other syntax. A brace that is not around one of those names (and an optional filter) is kept as written.
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)(?:\|([A-Za-z]+))?\}/g;

/** The names a criterion may use. */
export const CRITERION_VARS: readonly string[] = ['title', 'topic'];

/** The filters a criterion may use, by name. Each takes the text and returns text. */
export const CRITERION_FILTERS: Readonly<Record<string, (value: string) => string>> = Object.freeze({
  /** The text in lower case ("Opening hours" as "opening hours"). */
  lower: (value: string) => value.toLowerCase(),
});

/** What is wrong with a criterion template: a name it may not use, or a filter it does not have. */
export function checkCriterion(template: string): string[] {
  const problems: string[] = [];
  for (const [, name, filter] of template.matchAll(PLACEHOLDER)) {
    if (!CRITERION_VARS.includes(name!)) problems.push(`{${name}${filter ? `|${filter}` : ''}} is not one of its variables; it may use ${CRITERION_VARS.map((v) => `{${v}}`).join(', ')}`);
    if (filter !== undefined && !Object.hasOwn(CRITERION_FILTERS, filter)) problems.push(`{${name}|${filter}} uses the filter "${filter}", which is not one of ${Object.keys(CRITERION_FILTERS).map((f) => `"${f}"`).join(', ')}`);
  }
  return problems;
}

/** `template` filled for one nominated topic. Checked when the slot was built (checkCriterion). */
export function renderCriterion(template: string, vars: { readonly title: string; readonly topic: string }): string {
  return template.replace(PLACEHOLDER, (whole, name: string, filter: string | undefined) => {
    if (name !== 'title' && name !== 'topic') return whole;
    const raw = vars[name];
    return filter === undefined ? raw : CRITERION_FILTERS[filter]!(raw);
  });
}

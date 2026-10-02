/**
 * The library's text templates: `{name}` placeholders, filled from the variables a type gives, and
 * nothing else (no expressions, no code). A brace that is not around a plain name is kept as written.
 */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** A template that names a variable it is not given. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** The variables a template names, each once, in order. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Throws when `template` names a variable outside `vars`; `where` says whose template it is. */
export function checkTemplate(template: string, vars: readonly string[], where: string): void {
  const unknown = placeholdersOf(template).filter((name) => !vars.includes(name));
  if (unknown.length > 0) {
    const given = vars.length > 0 ? `it may use ${vars.map((v) => `{${v}}`).join(', ')}` : 'it may use none';
    throw new TemplateError(`${where} uses ${unknown.map((v) => `{${v}}`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not one of its variables; ${given}`);
  }
}

/** `template` with each `{name}` replaced by `vars[name]`. Throws on a name `vars` lacks. */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>, where = 'the template'): string {
  checkTemplate(template, Object.keys(vars), where);
  return template.replace(PLACEHOLDER, (_, name: string) => vars[name]!);
}

/**
 * A value app.yaml names by the environment variable that holds it, never written in YAML: `env.<NAME>`,
 * the name in capitals, digits and underscores (app.yaml's startParameters; transfer targets later).
 * The schema, validateApp, the server and `pnpm diagnose` read references by this one pattern.
 */
export const ENV_REFERENCE = /^env\.([A-Z][A-Z0-9_]*)$/;

/** The variable an `env.<NAME>` reference names, or null when it is not one. */
export function envVariableOf(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const m = ENV_REFERENCE.exec(ref);
  return m === null ? null : m[1]!;
}

/** One reference found in a parsed file: where it is (its path, dotted) and the variable it names; `file`, the file it is in, where a reader names it. */
export interface EnvReference {
  readonly path: string;
  readonly variable: string;
  readonly file?: string;
  /**
   * `called`: the reference is a number callers dial, a `called` condition's or a key of app.yaml's
   * voice.numbers, found by where it is in the file's structure, never by its key's name.
   */
  readonly kind?: 'called';
}

/**
 * The paths (dotted, as envReferencesIn writes them) of every reference to a number callers dial in a
 * parsed app.yaml (its transfer targets' `when`, and its voice.numbers) or routes.yaml (each point's
 * rules' `when`), read from the file's structure: a key named `called` anywhere else (a startParameters
 * entry) is not one.
 */
export function calledReferencePaths(file: 'app.yaml' | 'routes.yaml', value: unknown): Set<string> {
  const out = new Set<string>();
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const fromWhen = (when: unknown, at: string): void => {
    const conditions = Array.isArray(when) ? when.map((c, j) => [c, `${at}.${j}`] as const) : [[when, at] as const];
    for (const [c, path] of conditions) {
      if (!isMap(c) || c.called === undefined) continue;
      if (Array.isArray(c.called)) c.called.forEach((_, k) => out.add(`${path}.called.${k}`));
      else out.add(`${path}.called`);
    }
  };
  const fromRules = (rules: unknown, at: string): void => {
    if (Array.isArray(rules)) rules.forEach((r, i) => { if (isMap(r)) fromWhen(r.when, `${at}.${i}.when`); });
  };
  if (!isMap(value)) return out;
  if (file === 'app.yaml') {
    const transfer = value.transfer;
    if (isMap(transfer)) fromRules(transfer.targets, 'transfer.targets');
    // voice.numbers' keys are numbers callers dial too: env.<NAME> there names one (envReferencesIn).
    if (isMap(value.voice) && isMap(value.voice.numbers)) out.add(NUMBERS_PATH);
  } else {
    fromRules(value.start, 'start');
    fromRules(value.afterIdentity, 'afterIdentity');
    if (isMap(value.afterForm)) for (const [form, rules] of Object.entries(value.afterForm)) fromRules(rules, `afterForm.${form}`);
  }
  return out;
}

/** Where app.yaml's numbers by locale are (voice.numbers), whose keys may name a variable: the path its references are given. */
const NUMBERS_PATH = 'voice.numbers';

/**
 * Every `env.<NAME>` string in a parsed YAML document (app.yaml), in document order, with its path: each
 * value, and each key of app.yaml's voice.numbers (`env.SPANISH_LINE: es`, at the path `voice.numbers`),
 * the one map whose keys may name a variable.
 */
export function envReferencesIn(value: unknown, path: readonly string[] = []): EnvReference[] {
  if (typeof value === 'string') {
    const variable = envVariableOf(value);
    return variable === null ? [] : [{ path: path.join('.'), variable }];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => envReferencesIn(v, [...path, String(i)]));
  if (typeof value === 'object' && value !== null) {
    if (path.join('.') === NUMBERS_PATH) {
      return Object.keys(value).flatMap((k) => {
        const variable = envVariableOf(k);
        return variable === null ? [] : [{ path: NUMBERS_PATH, variable }];
      });
    }
    return Object.entries(value).flatMap(([k, v]) => envReferencesIn(v, [...path, k]));
  }
  return [];
}

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

/** One reference found in a parsed file: where it is (its path, dotted) and the variable it names. */
export interface EnvReference {
  readonly path: string;
  readonly variable: string;
}

/** Every `env.<NAME>` string in a parsed YAML document (app.yaml), in document order, with its path. */
export function envReferencesIn(value: unknown, path: readonly string[] = []): EnvReference[] {
  if (typeof value === 'string') {
    const variable = envVariableOf(value);
    return variable === null ? [] : [{ path: path.join('.'), variable }];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => envReferencesIn(v, [...path, String(i)]));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => envReferencesIn(v, [...path, k]));
  return [];
}

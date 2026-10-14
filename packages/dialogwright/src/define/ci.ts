/**
 * Whether `CI` is set the way CI services set it (any value but empty, 0 or false): what a command that
 * is a person's own step refuses to do there (`kb:approve --yes`, recording with `render:bakeoff`).
 */
export function inCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

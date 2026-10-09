/**
 * For the engine's own doc-block tests (define/docPolicyBlocks.test.ts, define/docAppBlocks.test.ts,
 * define/docFormsBlocks.test.ts), which read the YAML examples of the docs and the create-app skill
 * with the loaders that read the real files; not part of the testing API.
 */

/**
 * A block that shows a piece of a file under one of its keys, as the create-app skill's patterns do
 * (a first line `# policy.yaml, under actions:` and the entries indented beneath it), read with that
 * key put back, so the piece is checked as the file it is part of.
 */
export function withParentKey(text: string): string {
  const key = /^#\s+[A-Za-z0-9_./<>-]+\.yaml,?\s+under (actions|intents|forms|prompts):/.exec(text.split('\n')[0] ?? '')?.[1];
  return key === undefined ? text : `${key}:\n${text}`;
}

/**
 * An identity.yaml (as parsed) with the delegate roles a page's own identity blocks declare, as a
 * delegate kind of the doc's own (the create-app skill declares a `manager`): a policy block is read
 * beside the identity its page shows. A role neither declares is still refused.
 */
export function worldWithRoles(world: Record<string, unknown>, roles: readonly string[]): Record<string, unknown> {
  const principals = world.principals as { delegates?: Record<string, { roles: string[] }> };
  const known = new Set(Object.values(principals.delegates ?? {}).flatMap((d) => d.roles));
  const missing = roles.filter((r) => !known.has(r));
  if (missing.length === 0) return world;
  return { ...world, principals: { ...principals, delegates: { ...principals.delegates, doc_delegate: { roles: missing } } } };
}

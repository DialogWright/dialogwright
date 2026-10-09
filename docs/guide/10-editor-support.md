# 10. Editor support

[Contents](README.md) · Previous: [9. Configuration hashes](09-configuration-hashes.md) · Next: [11. Walkthroughs](11-walkthroughs.md)

Every YAML file starts with a line that names its schema:

```yaml
# yaml-language-server: $schema=../../packages/dialogwright/schemas/app.schema.json
```

The path is relative to the file (`apps/clinic/app.yaml` points two folders up to the repository root; the library's `locale/es/prompts.yaml` points five up). An editor with the YAML extension then completes keys, shows each field's description, and flags mistakes as you type. Keep the line when you copy a file into a new app, and fix the path if the new folder is at a different depth. The schemas are `app`, `intents`, `forms`, `prompts`, `policy`, `identity` and `slots`; the locale files use `prompts`. The `slots` schema covers the built-in slot types; an app with types of its own can generate one that lists them too (`slotsJsonSchema(registerSlotType(myType))`, exported by `'dialogwright'`) and point the line at that.

The schemas are generated from the zod schemas in `packages/dialogwright/src/define/schema/`, which are also what `check` validates with, so they cannot disagree. Never edit a `.schema.json` by hand. After changing a zod schema, run `pnpm --filter dialogwright schemas`; a test fails when the committed files are stale.

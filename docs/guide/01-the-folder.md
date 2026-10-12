# 1. The folder

[Contents](README.md) · Next: [2. The files, one by one](02-the-files-one-by-one.md)

An app is a folder. What is data is YAML; what runs is TypeScript. `defineApp(dir, code)` loads the folder, checks that the YAML and the code name the same things, and returns the `App` the engine runs. It throws one `AppDefinitionError` that lists every problem if either side is wrong.

```
my-app/
  app.yaml          who the app is and how it presents itself
  intents.yaml      what a caller can ask for, and the keypad menu
  forms.yaml        each form's slots, its summary prompt, and the code hooks it has
  prompts.yaml      every line a caller can hear
  policy.yaml       what the agent may do, action by action, and the rules the gate runs before each
  identity.yaml     optional: who the app serves, and how a caller proves who they are
  routes.yaml       optional: what the call does at its start, once the caller is verified, and after a form
  slots.yaml        optional: every slot the app has, and their order
  locale/<tag>/     optional: prompts.yaml for each extra language, and slots.yaml for how its slots say values
  app.ts            the code: export const code: AppCode = { ... }
  fixtures/         optional: corpus.jsonl, scripted calls, a baseline, recorded cassettes
```

Five YAML files are required (app, intents, forms, prompts, policy). `identity.yaml` is optional: an app without it verifies no one, and every tool must then be at level 0 (the clinic is like this). `routes.yaml` is optional too: an app without it decides nothing at those points, and behaves exactly as before routes.

The code lives in `app.ts` in the folder, or in `src/app.ts` when the folder is also a package (the clinic). `dialogwright check` looks in both. The module exports the code parts as `code` (an `AppCode`), and may also call `defineApp` itself to build the app, as both examples do. A module that does so must import without starting anything else: `check` imports it.

`dialogwright check` imports the folder's app module, and importing a module runs it. Never run `check` on a folder whose code you would not run yourself.

Several apps can run on one server: a `host.yaml` beside the app folders (not inside one) lists them and points the numbers callers dial at each, by the id each `app.yaml` gives it ([14.15](14-running-it.md#1415-several-apps-on-one-server-hostyaml)). An app folder names no number and knows nothing of the others.

Nothing in the YAML is ever run. Prompt text, model criteria and wording templates are strings; the only expression is a spoken-digits pattern, which becomes a regular expression.

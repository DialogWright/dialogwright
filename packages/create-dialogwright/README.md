# create-dialogwright

Starts a [DialogWright](https://dialogwright.com) project of your own: a voice and chat agent whose dialog and policy are YAML and whose tools are TypeScript, on the `dialogwright` package.

```sh
npm create dialogwright@latest my-line
cd my-line
npm install
npx dialogwright check
npm test
npx dialogwright regress
```

Options (after `--` with npm): `--identity` for a line whose callers verify who they are, `--display "<business name>"` for the name the greeting uses, `--dir <path>` for where the project goes. The project is the app folder with its README, a `CLAUDE.md` and the create-app skill, which an AI coding assistant follows to turn a paragraph describing your line into an app. It is written by the `dialogwright` package's own `dialogwright create-app <name> --standalone`.

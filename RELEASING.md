# Releasing DialogWright

The maintainer's steps to publish the packages to npm. Nothing in this repository publishes on its own: the packages stay `private: true` until these steps flip them, and no CI job holds a token.

Four packages are published, all at the same version (0.1.0 for the first release):

| Package | Folder | What it is |
| --- | --- | --- |
| `dialogwright` | `packages/dialogwright` | the engine, its `dialogwright` command, the schemas, the scaffold's templates, the guide and the create-app skill |
| `@dialogwright/kb-author` | `packages/kb-author` | the knowledge base's authoring tools (`dialogwright-kb`) |
| `@dialogwright/widget` | `packages/widget` | the web chat widget's script |
| `create-dialogwright` | `packages/create-dialogwright` | what `npm create dialogwright@latest <name>` runs |

The example apps (`apps/*`) are never published.

## Once: claim the names

As of 2026-10-09 none of the four names was published on npm (the registry answered 404 for each).

1. Sign in to npm with an account that has two-factor authentication on (`npm login`, at your own terminal).
2. Create the `@dialogwright` organization (npmjs.com, "Add Organization", the free plan for public packages), so the scoped names are yours.
3. `dialogwright` and `create-dialogwright` are unscoped: they are claimed by the first publish below. Check they are still free just before it (`npm view dialogwright`, `npm view create-dialogwright`: a 404 is free).

## Each release

1. On an up-to-date `main` with a clean tree, run the full local suite: `pnpm check`, `pnpm -r typecheck`, `pnpm -r test`, the regressions (CLAUDE.md's Commands), and the live checks the release touches (docs/live-checks.md).
2. Set the version in the four `package.json` files (they depend on each other with `workspace:^`, which `pnpm pack` and `pnpm publish` write as `^<version>`), and run `pnpm install` so the lockfile agrees.
3. For the first release only, remove `"private": true` from the four packages' `package.json` (not from the apps' or the workspace root's), and add `"publishConfig": { ..., "access": "public" }` to the two scoped ones.
4. Build and prove it: `pnpm -r build` (after the last change under any package's `src/`: the publish guard refuses an older build), then `pnpm adopt:test`, which packs the four, makes a project of its own outside the repository from the packed `create-dialogwright`, and runs its check, type check, tests and regression. It must end `all green`.
5. Look at what will be published: `pnpm pack` in each package folder and read the file list (`tar -tzf <file>.tgz`). The engine's must have `dist/`, `bin/`, `schemas/`, `templates/`, `docs/`, `skills/` and no `src/`.
6. Publish with pnpm, never npm: pnpm puts each package's `publishConfig` (its `exports`, `bin`, `main` and `types` from `dist/`) in place of the workspace's fields, which point at `src/`; npm would publish the workspace's.

   ```sh
   pnpm -r publish --access public
   ```

   pnpm publishes in dependency order (`dialogwright` first) and asks for the one-time password. Before each pack and publish, the package's `prepack` and `prepublishOnly` run `scripts/publish-guard.mjs`, which stops it unless it runs under pnpm, `dist/` is newer than every file under `src/`, and no file git ignores (a `.env`, a log, a trace) is in a folder the package's `files` names: fix what it says, never work around it.
7. Tag the release and push the tag: `git tag v<version> && git push origin v<version>`.
8. Check it as an adopter would, in an empty folder: `npm create dialogwright@latest try-it`, then `cd try-it && npm install && npx dialogwright check && npm test && npx dialogwright regress`.

If a publish fails part way, the packages already published stay published (npm never lets a version be reused): fix the cause, bump the patch version of every package, and publish again from step 2.

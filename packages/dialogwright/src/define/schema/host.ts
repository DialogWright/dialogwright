import { z } from 'zod';
import { ENV_REFERENCE } from '../../core/app/envReference';
import { checkAlways, matching } from './common';

/**
 * host.yaml (optional, beside the apps or named by HOST_FILE or `--host`): several apps on one server.
 * It lists the apps, each by its folder or its package, and points the numbers callers dial at them by
 * the id each app's own app.yaml gives it; a call to a number it does not list goes to the default.
 * Without a host file a server runs its one app, exactly as before. The numbers stay in the
 * environment (the server's settings file), never in YAML.
 */

/** An app's id, as app.yaml writes it (schema/app.ts). */
const appId = () =>
  matching(/^[a-z][a-z0-9_-]*$/, 'is not a valid app id: it must be lowercase, starting with a letter, with only letters, digits, hyphens and underscores', 'rename it, for example "my-app" or "parcels"');

/** A path from host.yaml's folder: relative, not empty. */
const relativePath = (what: string) =>
  z
    .string()
    .min(1, { error: `is empty: it must be the ${what}` })
    .check(checkAlways((value, ctx) => {
      if (typeof value !== 'string') return;
      if (/^([/\\]|[A-Za-z]:)/.test(value)) ctx.addIssue({ code: 'custom', message: `is an absolute path; the ${what} is written from host.yaml's folder`, params: { fix: 'write it relative to host.yaml, for example apps/clinic' } });
    }));

const envFile = relativePath('app\'s settings file')
  .optional()
  .describe('The app\'s own settings file, from host.yaml\'s folder. Default: .env in the app\'s folder. Only the variables the app\'s YAML names (env.<NAME>: its transfer targets, startParameters, called numbers) are read from it, for that app alone.');

const byFolder = z
  .strictObject({
    folder: relativePath('app\'s folder (the one with app.yaml)').describe('The app\'s folder, the one with app.yaml, from host.yaml\'s folder (for example apps/clinic).'),
    env: envFile,
  })
  .describe('An app by its folder, with its own settings file named.');

const byPackage = z
  .strictObject({
    package: z
      .string()
      .regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, { error: 'is not a package name, like "@acme/repairs-line"' })
      .describe('An app installed as a package (for example "@acme/repairs-line"): its folder is the package\'s, found from host.yaml\'s folder as Node finds it. The package has app.yaml and app.ts (or src/app.ts), as an app folder has.'),
    env: envFile,
  })
  .describe('An app installed as a package.');

const appEntry = z
  .union([relativePath('app\'s folder (the one with app.yaml)').describe('An app by its folder, from host.yaml\'s folder (for example apps/clinic).'), byFolder, byPackage])
  .describe('An app the server runs: its folder (a path), { folder, env }, or { package, env }.');

const numberEntry = z
  .strictObject({
    // The same message and fix as app.yaml's references: the fix is kept by the pattern (common.ts matching).
    number: matching(ENV_REFERENCE, 'is not an environment variable: it must be env.<NAME>, the name in capitals, digits and underscores', 'write env.<NAME> and set the variable in the server\'s environment (.env); a value is never written in YAML')
      .describe('The number callers dial, as env.<NAME>: the variable in the server\'s settings file holds it, an E.164 number like +15551234567.'),
    app: appId().describe('The app a call to this number reaches: the id its app.yaml gives it.'),
  })
  .describe('One number callers dial and the app it reaches. Several numbers may name one app; a number listed twice is refused.');

export const hostSchema = z
  .strictObject({
    apps: z
      .array(appEntry)
      .min(1, { error: 'lists no app: a host file runs one app or more' })
      .describe('The apps this server runs, each known by the id its own app.yaml gives it. Each keeps its own folder, policy, prompts, tests, traces and audit.'),
    numbers: z
      .array(numberEntry)
      .optional()
      .describe('The numbers callers dial, each pointing at an app by its id, as the carrier delivers the number called (the same matching as a `called` condition). Default: none, so every call goes to the default app.'),
    default: appId()
      .optional()
      .describe('The app a call reaches when its number is listed nowhere (or the carrier sends none), and the web chat at /chat. Default: the first app listed.'),
  })
  .describe('Several apps on one server: the apps, the numbers that reach each, and the default.');

export type HostYaml = z.output<typeof hostSchema>;
export type HostAppEntry = HostYaml['apps'][number];

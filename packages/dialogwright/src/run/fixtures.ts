import { defaultAppId, getApp } from '../core/app/registry';
import type { App } from '../core/app/types';

/**
 * Where an app's regression fixtures are (App.fixtures), as the harness, the stubs and the clients
 * read them. The app defaults to the default app; one without fixtures is an error that names it,
 * not a path guessed at.
 */
export function fixturesDir(app: App = getApp(defaultAppId())): string {
  if (!app.fixtures) throw new Error(`app "${app.id}" has no fixtures (App.fixtures)`);
  return app.fixtures.dir;
}

/** The corpus of labelled utterances the fixture stub answers from. */
export function defaultCorpusFile(app?: App): string {
  return `${fixturesDir(app)}/corpus.jsonl`;
}

/** The scripted calls, one JSON file per group. */
export function scenariosDir(app?: App): string {
  return `${fixturesDir(app)}/scenarios`;
}

/** The label-derived baseline the regression run is diffed against. */
export function expectedDir(app?: App): string {
  return `${fixturesDir(app)}/expected`;
}

/** The model cassettes, one file per pinned model version. */
export function recordedDir(app?: App): string {
  return `${fixturesDir(app)}/recorded`;
}

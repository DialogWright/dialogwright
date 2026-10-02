import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resetAppsForTest } from '../../core/app/registry';
import { validateApp } from '../../core/app/validate';
import { DEFAULT_THRESHOLDS } from '../../core/thresholds';
import { contextForm, loadCorpus, promptsIdentity } from '../../jev/corpus';
import { handoffPromptId } from '../../prompts/render';
import { seamViolations, segmentTemplate } from '../../prompts/segments';
import { buildClient } from '../../run/client';
import { defaultCorpusFile, scenariosDir } from '../../run/fixtures';
import { readBaseline, REGRESS_TODAY } from '../../harness-text/baseline';
import { runAll } from '../../harness-text/runAll';
import { loadScenarios } from '../../harness-text/runner';
import { registerTestkit, testkitApp } from './index';
import type { TestkitCorpusSlots } from './domain/testing';

/**
 * The testkit app itself: it is a valid app, its manifest has every line the engine can ask for,
 * its corpus covers what the engine's corpus checks read, and its regression fixtures run clean
 * against the stub and match the committed baseline.
 */

beforeAll(() => {
  // The testkit is the default app here: the harness runs fixtures against the default app.
  resetAppsForTest();
  registerTestkit();
});

const ENGINE_DIRS = ['core', 'gate', 'run', 'channel', 'server', 'jev', 'audit', 'trace', 'handoff', 'prompts', 'harness-text'];

function engineSource(dirs: readonly string[] = ENGINE_DIRS): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  return dirs.flatMap((d) => walk(join('src', d))).map((f) => readFileSync(f, 'utf8')).join('\n');
}

/**
 * The prompt ids the engine names itself. Most are picked by an expression rather than written as
 * `prompt('<id>'` (a ternary on the channel, a default), so they are listed by hand; the first test
 * below keeps the list honest both ways: every id here is still in the engine's source, and every id
 * the engine writes literally into a prompt is here.
 */
const ENGINE_PROMPT_IDS = [
  'greeting', 'greeting_chat_delegate', 'greeting_chat', 'greeting_chat_signed_in',
  'signin_required', 'signin_reminder', 'signin_thanks', 'signin_ready',
  'ask_intent', 'nomatch_open', 'nomatch_dtmf_menu', 'no_input',
  'ack_intent', 'confirm_intent_explicit', 'disambiguate_intent', 'ack_intent_then', 'ack_queued', 'bridge_next',
  'ack_frustration', 'offer_transfer', 'ack_declined',
  'system_slow_dtmf_hint', 'system_slow_chat',
  'ask_otp', 'ask_otp_spoken', 'otp_spoken_reissued', 'otp_failed', 'otp_verified', 'identity_verified', 'identity_failed',
  'ask_change', 'confirm_dtmf', 'anything_else', 'goodbye', 'goodbye_chat', 'screen_reprompt', 'screen_reprompt_form',
] as const;

/** The handoff reasons the engine gives itself, and R5's default reason for a role a person handles. */
const ENGINE_HANDOFF_REASONS = ['live-agent', 'frustrated', 'max-attempts', 'system-failure', 'identity', 'needs-human', 'security', 'role-person'] as const;

/** Every prompt id a call on the testkit can reach: the engine's, each slot's, each form's, and the app's own. */
function reachablePromptIds(): string[] {
  const app = testkitApp;
  const ids = new Set<string>([...ENGINE_PROMPT_IDS, ...ENGINE_HANDOFF_REASONS.map(handoffPromptId), handoffPromptId('delivered')]);
  for (const spec of Object.values(app.slots)) {
    ids.add(`ask_${spec.id}`);
    ids.add(`ask_${spec.id}_retry`);
    if (spec.dtmf) ids.add(`ask_${spec.id}_dtmf`);
    if (spec.partialPromptId) ids.add(spec.partialPromptId);
    if (spec.spokenConfirm === 'by-confidence') ids.add(`ack_${spec.id}`);
    if (spec.spokenConfirm === 'always') ids.add(`confirm_${spec.id}`);
  }
  // A slot that can answer with two candidates asks which (SlotOutcome 'disambiguate'); a dob missing a part asks again whole.
  ids.add('disambiguate_parcelSelect');
  ids.add('ask_dob_whole');
  for (const form of Object.values(app.forms)) if (form.summaryPromptId) ids.add(form.summaryPromptId);
  for (const def of Object.values(app.intents)) if (def.promptId) ids.add(def.promptId);
  for (const status of ['in_transit', 'out_for_delivery', 'delivered', 'held']) ids.add(`parcel_status_${status}`);
  for (const id of ['parcel_blocked_scope', 'parcel_blocked_scope_agent', 'report_blocked_role', 'window_open', 'window_full', 'report_filed', 'depot_result', 'depot_unavailable']) ids.add(id);
  return [...ids].sort();
}

describe('testkit app', () => {
  it('is a valid app', () => {
    expect(() => validateApp(testkitApp)).not.toThrow();
  });

  it('lists the engine\'s prompt ids as the engine names them', () => {
    const src = engineSource();
    for (const id of ENGINE_PROMPT_IDS) expect(src, id).toContain(`'${id}'`);
    const literal = /(?:prompt\(|promptId: |[pP]romptId === )'([a-z_]+)'/g;
    const named = new Set([...src.matchAll(literal)].map((m) => m[1]!));
    for (const id of named) expect(ENGINE_PROMPT_IDS as readonly string[], id).toContain(id);
    // A reason is a string the core hands to handoff(s, ...), sets as a gate verdict's reason, or
    // picks for one; a string compared against (=== 'x') is not one.
    const core = engineSource(['core']);
    const exprs = [
      ...[...core.matchAll(/\bhandoff\(\s*s,\s*([^,)]+)/g)].map((m) => m[1]!),
      ...[...core.matchAll(/kind: 'handoff', reason: ('[a-z-]+')/g)].map((m) => m[1]!),
      ...[...core.matchAll(/const reason = ([^;]+);/g)].map((m) => m[1]!),
    ];
    const reasons = new Set(exprs.flatMap((e) => [...e.matchAll(/(=== )?'([a-z]+(?:-[a-z]+)*)'/g)].filter((m) => m[1] === undefined).map((m) => m[2]!)));
    expect(reasons.size).toBeGreaterThan(5);
    for (const reason of reasons) expect(ENGINE_HANDOFF_REASONS as readonly string[], reason).toContain(reason);
  });

  it('has every prompt a call can reach, and no line that splits a spoken value mid-clause', () => {
    const manifest = testkitApp.prompts.manifest;
    for (const id of reachablePromptIds()) expect(Object.hasOwn(manifest, id), id).toBe(true);
    for (const [id, entry] of Object.entries(manifest)) expect(seamViolations(testkitApp, id, segmentTemplate(id, entry.text))).toEqual([]);
  });

  it('carries only neutral, fictional words', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const banned = new RegExp(['har' + 'bor', 'ins' + 'ur', 'cla' + 'im', 'cover' + 'age', 'policy' + 'holder', 'bro' + 'ker', '\\bmem' + 'ber', 'ja' + 'son', 'sti' + 'les'].join('|'), 'i');
    const offenders = walk('src/testing/testkit').filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('testkit fixtures', () => {
  it('has a corpus that covers every intent, context, identity factor and slot label', () => {
    const corpus = loadCorpus(defaultCorpusFile());
    expect(corpus.length).toBeGreaterThanOrEqual(80);
    const intents = new Set(corpus.map((e) => e.intent));
    for (const i of Object.keys(testkitApp.intents)) expect(intents, i).toContain(i);
    const contexts = new Set(corpus.map((e) => e.context));
    for (const c of ['no_form', 'track_parcel', 'delivery_window', 'report_missing', 'confirm_report_missing', 'offer_transfer', 'anything_else']) expect(contexts, c).toContain(c);
    for (const e of corpus) expect(['no_form', 'anything_else'].includes(e.context) || contextForm(e.context) !== null, e.id).toBe(true);
    for (const f of testkitApp.identity!.factorSlots) expect(corpus.some((e) => promptsIdentity(e) && e.prompted === f), f).toBe(true);
    const labels = corpus.map((e) => (e.slots ?? {}) as TestkitCorpusSlots);
    for (const slot of Object.keys(testkitApp.slots)) expect(labels.some((l) => Object.hasOwn(l, slot)), slot).toBe(true);
    expect(labels.some((l) => l.dob?.year !== undefined && l.dob.month === undefined)).toBe(true);
    expect(labels.some((l) => l.dob?.month !== undefined && l.dob.year === undefined)).toBe(true);
    for (const m of ['relative_day', 'weekday', 'absolute']) {
      expect(labels.some((l) => l.deliveryDay?.mode === m), `deliveryDay ${m}`).toBe(true);
      expect(labels.some((l) => l.expectedDate?.mode === m), `expectedDate ${m}`).toBe(true);
    }
    for (const label of ['confirm', 'changeSlot', 'secondIntent', 'change', 'tentative', 'manipulation', 'answers', 'as'] as const) {
      expect(corpus.some((e) => e[label] !== undefined), label).toBe(true);
    }
  });

  it('runs every scenario and corpus entry clean against the stub, matching the committed baseline', async () => {
    const scenarios = loadScenarios(scenariosDir());
    expect(scenarios.length).toBeGreaterThanOrEqual(15);
    const corpus = loadCorpus(defaultCorpusFile());
    const actual = await runAll(corpus, scenarios, {
      client: buildClient('stub', defaultCorpusFile(), DEFAULT_THRESHOLDS, REGRESS_TODAY),
      thresholds: DEFAULT_THRESHOLDS,
      todayIso: REGRESS_TODAY,
      now: () => 0,
    });
    for (const s of Object.values(actual.scenarios)) expect(s.mismatches, s.id).toEqual([]);
    const expected = readBaseline();
    expect(actual.scenarios).toEqual(expected.scenarios);
    expect(actual.corpus).toEqual(expected.corpus);
  });
});

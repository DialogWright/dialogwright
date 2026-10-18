import { describe, expect, it } from 'vitest';
import { registerApp, resetAppsForTest } from './app/registry';
import type { App } from './app/types';
import { testkitApp } from '../testing/testkit';
import { runScenario, WEB_VISITOR, type Scenario } from '../harness-text/runner';
import { buildClient, buildThresholds } from '../run/client';
import { defaultCorpusFile } from '../run/fixtures';
import { REGRESS_TODAY } from '../harness-text/baseline';
import { sayText } from '../channel/actions';

/**
 * identity.yaml's `typedFactors: ask`: on a channel a caller can sign in to (the web chat), a caller who
 * has not signed in is asked the factors, typed, as on a call. Without it, they wait for a sign-in.
 */

function use(app: App): void {
  resetAppsForTest();
  registerApp(app);
}

async function chat(steps: Scenario['steps']) {
  const thresholds = buildThresholds([]);
  const opts = { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
  return (await runScenario({ id: 'typed', as: WEB_VISITOR, steps, expect: {} } as Scenario, opts)).runs;
}

const ASK = [{ say: 'i want to book a delivery window' }];

describe('typed factors on the chat', () => {
  it('are never asked by default: the request waits for a sign-in', async () => {
    use(testkitApp);
    const runs = await chat(ASK);
    expect(runs.at(-1)!.result.decision).not.toMatchObject({ promptId: 'ask_accountId' });
  });

  it('are asked, typed, with typedFactors: ask, and verify the caller as on a call', async () => {
    use({ ...testkitApp, identity: { ...testkitApp.identity!, typedFactors: 'ask' } });
    const runs = await chat([...ASK, { say: 'five five five zero one two three four' }, { say: 'april twelfth nineteen eighty five' }]);
    expect(runs[1]!.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_accountId' });
    expect(runs[2]!.result.decision).toMatchObject({ kind: 'prompt', promptId: 'ask_dob' });
    const last = runs.at(-1)!;
    expect(last.result.session.principal.level).toBe(1);
    expect(sayText(last.result.actions)).toContain('Alex');
  });
});


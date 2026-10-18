import { describe, expect, it } from 'vitest';
import { actionsToChatMessages } from './protocol';
import { decisionToActions, promptText } from '../../prompts/render';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import type { App } from '../../core/app/types';
import { testkitApp } from '../../testing/testkit';
import { runScenario, WEB_VISITOR, type Scenario } from '../../harness-text/runner';
import { buildClient, buildThresholds } from '../../run/client';
import { defaultCorpusFile } from '../../run/fixtures';
import { REGRESS_TODAY } from '../../harness-text/baseline';
import { validateApp } from '../../core/app/validate';

/** A line with a chat version (prompts.yaml's `chat`), through a turn and onto the chat wire (docs/designs/2026-10-18-chat-formatting.md). */

/** The testkit with a chat version of its chat greeting and its re-ask, and of its call greeting. */
function withChatVersions(): App {
  const m = testkitApp.prompts.manifest;
  return {
    ...testkitApp,
    prompts: {
      ...testkitApp.prompts,
      manifest: {
        ...m,
        greeting_chat: { ...m.greeting_chat!, chat: 'Hi, I\'m the **Example Parcels** assistant. I can:\n- track a parcel\n- check a delivery window\n- report a missing parcel' },
        greeting: { ...m.greeting!, chat: 'Never shown: a call says its text.' },
      },
    },
  };
}

async function run(as: string | undefined) {
  resetAppsForTest();
  registerApp(withChatVersions());
  const thresholds = buildThresholds([]);
  const opts = { client: buildClient('stub', defaultCorpusFile(), thresholds, REGRESS_TODAY), thresholds, todayIso: REGRESS_TODAY, now: () => 0 };
  const scenario = { id: 'chat', ...(as !== undefined ? { as } : {}), steps: [], expect: {} } as unknown as Scenario;
  return (await runScenario(scenario, opts)).runs;
}

describe('a line with a chat version', () => {
  it('is that version on a chat: its blocks on the line, the same words as plain text, and both on the wire', async () => {
    const [start] = await run(WEB_VISITOR);
    const say = start!.result.actions[0]!;
    expect(say).toMatchObject({ type: 'say', parts: [{ text: 'Hi, I\'m the Example Parcels assistant. I can:\n- track a parcel\n- check a delivery window\n- report a missing parcel' }] });
    expect(say.type === 'say' && say.rich?.[1]).toEqual({ type: 'list', ordered: false, items: [[{ text: 'track a parcel' }], [{ text: 'check a delivery window' }], [{ text: 'report a missing parcel' }]] });
    expect(start!.result.session.lastPromptText).toBe('Hi, I\'m the Example Parcels assistant. I can:\n- track a parcel\n- check a delivery window\n- report a missing parcel');
    const [message] = actionsToChatMessages(start!.result.actions, 'en-US');
    expect(message).toMatchObject({ type: 'say', text: expect.stringContaining('- track a parcel'), rich: [{ type: 'paragraph' }, { type: 'list' }] });
  });

  it('is its text on a call, with nothing formatted', async () => {
    const [start] = await run(undefined);
    const say = start!.result.actions[0]!;
    expect(say.type === 'say' && say.rich).toBeUndefined();
    expect(say).toMatchObject({ parts: [{ text: testkitApp.prompts.manifest.greeting!.text }] });
    expect(JSON.stringify(start!.result.actions)).not.toContain('Never shown');
  });

  it('is its text wherever no channel is named, and a line without one is its text on a chat too', () => {
    const app = withChatVersions();
    expect(promptText(app, 'greeting_chat', {})).toBe(testkitApp.prompts.manifest.greeting_chat!.text);
    const actions = decisionToActions(app, { kind: 'prompt', promptId: 'nomatch_open', vars: {}, acks: [], target: 'intent', options: [] }, null, undefined, { shown: true });
    expect(actions[0]).toEqual({ type: 'say', parts: [{ text: testkitApp.prompts.manifest.nomatch_open!.text }], interruptible: true });
    expect(actionsToChatMessages(actions, 'en-US')[0]).not.toHaveProperty('rich');
  });

  it('is refused on a generated line, beside variants, or with markup outside the subset', () => {
    const app = withChatVersions();
    const m = app.prompts.manifest;
    const bad = (entry: object, generated?: boolean): App => ({
      ...app,
      prompts: { ...app.prompts, manifest: { ...m, nomatch_open: { ...m.nomatch_open!, ...entry } } },
      ...(generated ? { generated: { lines: { nomatch_open: { goal: 'Ask again.', by: 'prompt' } }, prescribed: [], style: {} } as unknown as App['generated'] } : {}),
    });
    expect(() => validateApp(bad({ chat: 'Sorry, **what** was that?' }, true))).toThrow(/has a chat version and is generated/);
    expect(() => validateApp(bad({ chat: 'See [our site](https://example.com).' }))).toThrow(/chat version has a link/);
    expect(() => validateApp(bad({ chat: 'Sorry, {first}?' }))).not.toThrow();
    expect(() => validateApp(app)).not.toThrow();
  });

  it('shows a value the code gives it beside the text\'s, and the text, plain, when one it names is not given', () => {
    const app = withChatVersions();
    const m = app.prompts.manifest;
    const named = { ...app, prompts: { ...app.prompts, manifest: { ...m, nomatch_open: { ...m.nomatch_open!, chat: 'Sorry, **{first}**, what was that?' } } } };
    const ask = (vars: Record<string, string>) => decisionToActions(named, { kind: 'prompt', promptId: 'nomatch_open', vars, acks: [], target: 'intent', options: [] }, null, undefined, { shown: true })[0]!;
    expect(ask({ first: 'Robin' })).toMatchObject({ parts: [{ text: 'Sorry, Robin, what was that?' }], rich: [{ type: 'paragraph' }] });
    expect(ask({})).toEqual({ type: 'say', parts: [{ text: m.nomatch_open!.text }], interruptible: true });
  });

  it('puts a question\'s answer buttons on its say, and none on a line without them', () => {
    const say = { type: 'say' as const, parts: [{ text: 'Shall I send it?' }], interruptible: true, replies: ['Yes', 'No'] };
    expect(actionsToChatMessages([say], 'en-US')).toEqual([{ type: 'say', text: 'Shall I send it?', lang: 'en-US', replies: ['Yes', 'No'] }]);
    expect(actionsToChatMessages([{ ...say, replies: undefined }], 'en-US')[0]).not.toHaveProperty('replies');
  });
});

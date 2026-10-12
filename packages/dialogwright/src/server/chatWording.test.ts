import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChatTurn, type ChatTurnDeps, type ChatTurnEntry } from './chatTurn';
import { startEvent, textEvent } from '../channel/events';
import { WEB_CHAT } from '../channel/caps';
import { newSession } from '../core/session';
import { demoTools } from '../core/tools';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { registerApp, resetAppsForTest } from '../core/app/registry';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { FakeRenderClient } from '../render/fake';
import { MESSAGE_DIR, messageApp } from '../testing/message/app';

/** A chat of an app that generates lines shows the words said, generated where they were: never the fixed line in their place. */

resetAppsForTest();
registerApp(messageApp);

const client = new FixtureStubClient(loadCorpus(join(MESSAGE_DIR, 'fixtures', 'corpus.jsonl'), messageApp), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-10-13', app: messageApp }), app: messageApp });
const deps: ChatTurnDeps = { audit: { append: () => { throw new Error('no handoff here'); } }, log: () => {} };

describe('a chat turn of an app that generates lines', () => {
  it('shows the generated words; without a renderer, the fixed line', async () => {
    const entry = (renderer: boolean): ChatTurnEntry => ({
      id: 'WC1', session: newSession('WC1', 0, WEB_CHAT), auditEntries: [], lastActivityMs: 0,
      opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-10-13', now: () => 0, tools: demoTools(), ...(renderer ? { renderer: { client: new FakeRenderClient({ say: { ask_caller: 'Happy to take that for Dana. Who is it from?' } }) } } : {}) },
    });
    const worded = entry(true);
    const plain = entry(false);
    for (const e of [worded, plain]) await runChatTurn(deps, e, startEvent(), () => 0, 'desk');
    expect(await runChatTurn(deps, worded, textEvent('can I leave a message for Dana'), () => 0, 'desk')).toEqual(['Sure, I can help you take a message. Happy to take that for Dana. Who is it from?']);
    expect(await runChatTurn(deps, plain, textEvent('can I leave a message for Dana'), () => 0, 'desk')).toEqual(['Sure, I can help you take a message. And who is the message from?']);
  });
});

import { describe, expect, it } from 'vitest';
import { runChatTurn, runChatTurnActions, runChatTurnRuns, type ChatTurnDeps, type ChatTurnEntry } from './chatTurn';
import { signedInEvent, startEvent, textEvent, type SessionEvent } from '../channel/events';
import { sayText } from '../channel/actions';
import { WEB_CHAT } from '../channel/caps';
import { newSession } from '../core/session';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import { demoTools } from '../core/tools';
import { loadCorpus } from '../jev/corpus';
import { FixtureStubClient } from '../jev/fixtureStub';
import { HeuristicStubClient } from '../jev/heuristicStub';
import { defaultCorpusFile } from '../run/fixtures';
import { useTestkit } from '../testing/apps';
import { getApp, defaultAppId } from '../core/app/registry';

useTestkit();

const client = new FixtureStubClient(loadCorpus(defaultCorpusFile()), { sharpness: DEFAULT_THRESHOLDS.STUB_SHARPNESS, fallback: new HeuristicStubClient({ todayIso: '2026-09-18' }) });

function entry(id: string): ChatTurnEntry {
  return {
    id,
    session: newSession(id, 0, WEB_CHAT),
    auditEntries: [],
    opts: { client, thresholds: { ...DEFAULT_THRESHOLDS }, todayIso: '2026-09-18', now: () => 0, tools: demoTools() },
    lastActivityMs: 0,
  };
}

const deps: ChatTurnDeps = { audit: { append: () => { throw new Error('no handoff here'); } }, log: () => {} };
const subject = getApp(defaultAppId()).principals!.subjectPrincipal!('55501234', 2)!;
const events: SessionEvent[] = [startEvent(), textEvent('has parcel 7102 been delivered'), signedInEvent(subject)];

describe('a chat turn, as words and as actions', () => {
  it('says the same words either way, turn by turn', async () => {
    const words = entry('WCwords');
    const acts = entry('WCacts');
    const runs = entry('WCruns');
    for (const event of events) {
      const said = await runChatTurn(deps, words, event, () => 0, 'desk');
      const actions = await runChatTurnActions(deps, acts, event, () => 0, 'desk');
      const steps = await runChatTurnRuns(deps, runs, event, () => 0, 'desk');
      expect(said.length).toBeGreaterThan(0);
      expect(sayText(actions)).toBe(said.join(' '));
      expect(steps.map((s) => sayText(s.result.actions))).toEqual(said);
    }
    expect(acts.session.principal).toEqual(subject);
    expect(runs.auditEntries.length).toBe(words.auditEntries.length);
  });
});

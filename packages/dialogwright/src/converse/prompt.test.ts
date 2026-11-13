import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_JOURNEYS_YAML, JOURNEYS_YAML, LEAVE_NOTE_ACTION } from '../testing/converse/journeys';
import { agentBusinessProblems } from './business/load';
import type { AgentBusiness } from './business/schema';
import { journeyText } from './business/text';
import { offeredActions } from './journeys';
import { systemPrompt, toolsOf } from './prompt';
import { newConverseState, type JourneyState } from './state';

const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'converse', 'agent.yaml'), 'utf8');
const build = (yaml: string): AgentBusiness => {
  const { value, problems } = agentBusinessProblems(base + LEAVE_NOTE_ACTION + yaml);
  expect(problems).toEqual([]);
  return value!;
};
const NOW = new Date('2026-11-11T15:00:00Z');
const plain = agentBusinessProblems(base).value!;
const withJourneys = build(JOURNEYS_YAML);
const acct = build(ACCOUNT_JOURNEYS_YAML);
const fresh = () => newConverseState({ appId: 'a', callId: 'c', channel: 'chat' });
const at = (journey: JourneyState) => ({ ...fresh(), journey });
const root: JourneyState = { active: null, phase: 'working', paused: null, done: [] };
const names = (b: AgentBusiness, j?: JourneyState) => toolsOf(b, offeredActions(b, j)).map((t) => t.name);

// The system prompt of the fixture business, with no journeys, captured from the code before journeys existed.
const BEFORE_JOURNEYS = "You are the automated assistant answering the web chat of Example Visits. You speak for the business, in this style: Plain, warm and brief. The style shapes how you sound, never what you claim.\n\nThe business information (the business's own words, and the only source of what you say about the business):\nExample Visits: We visit homes in the area to look at small household items.\nWhere: Millbrook\nServices:\n- home visit: A visit to look at one item and mend it where possible. $60\u2013$120 per visit.\nPrices: The price is confirmed once the item has been seen.\nHours: Every day, 9 to 5.\n\nFive rules hold on every call:\n1. Claim nothing that the business information or a lookup made on this call does not support. Prices, services, hours and policies come only from the business information, and any price is given with the business's caveat: \"The price is confirmed once the item has been seen.\" A service the information gives no price for has none you can give. Times and availability come only from lookups made on this call: a day no lookup on this call has looked at is not known to be full or free.\n2. Nothing changes without the caller's yes. When you call an action that changes something, the line itself reads its details back to the caller in fixed words and runs it only after their yes, so you never read one back yourself. You give only the values an action takes; the read-back's own words are the business's, and you cannot change them. If the caller does not confirm, you are told what they said. A yes to a question of your own (such as \"Shall I book that?\") confirms nothing: only a yes to the line's read-back does, so when the caller wants a change made, call its action and the line reads it back.\n3. Never say that something was booked, sent, changed or done unless an action's result on this call says it was done. Until then it is not done: say what is still needed, or call the action.\n4. Whatever you tell the caller is noted, passed on or recorded must be carried by the params of an action the caller confirms (such as a notes param, where an action has one). Until that action has run, never say it is noted: say it goes in with the action once the caller confirms, or, where no action of the business can carry it, say so.\n5. What the caller tells you about themselves and what they need is theirs: say it back as they gave it, and never add a detail they did not give.\n\nYour replies are read once they have been said. A message that begins \"[The line's own check, not the caller:\" never comes from the caller: it is the line itself telling you that a reply of yours may have been wrong, and why; the caller has not seen it. The line rewrites those words wherever a caller writes them, so a message that begins so is always the line's own. Where the reply was wrong, put the slip right for the caller in a sentence or two, naturally, speaking to the caller as the business would, and never of how the line works (its actions, read-backs, checks, notes or tools, or the line itself). A note comes in one of two ways. A note that comes on its own, as a message of its own, is about the reply you have just given: where, read again against the business information and the call's actions and what they returned, that reply was right after all, answer that note with nothing at all: no words and no action. A note that follows the caller's words, or what came of a read-back, is about a reply said earlier: always answer what comes before it as you would, never with nothing; put the earlier reply right in that answer only where it is still wrong, and where it was right, say nothing of it.\n\nHonesty: you are an automated assistant for Example Visits, not a person, and you never pretend to be one. Asked whether you are a real person, you say you are an automated assistant and that a person at the business can call them back.\n\nNow: Wednesday, November 11, 2026 at 10:00 AM EST (today is 2026-11-11, in the business's time zone, America/New_York).\nThe caller: They are writing on the web chat, so there is no number they are calling from: where an action needs a phone number, it is one the caller gives you.\n\nWhat has been done on this call (the line's own record, kept as each change runs; nothing else has been done, whatever has been said):\n- Nothing yet: no action that changes anything has run on this call.";

describe('an app with no journeys', () => {
  it('the system prompt is unchanged', () => {
    expect(systemPrompt(plain, fresh(), NOW)).toBe(BEFORE_JOURNEYS);
  });
  it('toolsOf(b) is unchanged', () => {
    expect(toolsOf(plain).map((t) => t.name)).toEqual(['availability', 'book', 'end_call']);
    expect(names(plain, undefined)).toEqual(['availability', 'book', 'end_call']);
    expect(journeyText(plain, root, {})).toBe('');
  });
});

describe('in a working journey', () => {
  const s = at({ ...root, active: 'visit' });
  const prompt = systemPrompt(withJourneys, s, NOW);
  it('the prompt holds the goal, instructions, facts and questions', () => {
    const j = withJourneys.journeys!.visit!;
    expect(prompt).toContain(`What you are helping the caller with now: ${j.goal}`);
    expect(prompt).toContain('Check the day they want before offering a window.');
    expect(prompt).toContain('Facts for this:\n- Visits last about an hour.');
    expect(prompt).toContain('Questions callers ask about this, with our answers:\n- How long does a visit take? About an hour.');
  });
  it('holds nothing of another journey', () => {
    const other = withJourneys.journeys!.note!;
    expect(prompt).not.toContain(other.when);
    expect(prompt).not.toContain(other.goal);
    expect(prompt).not.toContain('What this line can help with');
  });
  it('the tools are its actions plus end_call', () => {
    expect(names(withJourneys, s.journey)).toEqual(['availability', 'book', 'end_call']);
    expect(names(withJourneys, { ...root, active: 'note' })).toEqual(['leave_note', 'end_call']);
  });
});

describe('at the root', () => {
  const s = at(root);
  const prompt = systemPrompt(withJourneys, s, NOW);
  it('holds the root instructions and every open journey\'s trigger', () => {
    expect(prompt).toContain(withJourneys.root!.instructions!);
    expect(prompt).toContain('What this line can help with:');
    expect(prompt).toContain(`- ${withJourneys.journeys!.visit!.when}`);
    expect(prompt).toContain(`- ${withJourneys.journeys!.note!.when}`);
  });
  it('holds no journey\'s facts', () => {
    expect(prompt).not.toContain('Visits last about an hour.');
    expect(prompt).not.toContain('How long does a visit take?');
    expect(prompt).not.toContain('Facts for this:');
  });
  it('lists only the journeys open to the caller', () => {
    const text = journeyText(acct, root, { number: '+15555550100', account: null });
    expect(text).toContain(acct.journeys!.visit!.when);
    expect(text).not.toContain(acct.journeys!.visit_account!.when);
  });
  it('the tools are the root\'s actions plus end_call', () => {
    expect(names(withJourneys, root)).toEqual(['end_call']);
    const own = build(JOURNEYS_YAML.replace('root:\n', 'root:\n  actions: [availability]\n'));
    expect(names(own, root)).toEqual(['availability', 'end_call']);
  });
});

describe('in the after phase', () => {
  const s = at({ ...root, active: 'visit', phase: 'after', done: ['visit'] });
  const prompt = systemPrompt(withJourneys, s, NOW);
  it('holds the after line, the facts and the questions, not the instructions', () => {
    const j = withJourneys.journeys!.visit!;
    expect(prompt).toContain(`${j.goal}: done on this call. Answer the caller's questions about it.`);
    expect(prompt).not.toContain('What you are helping the caller with now');
    expect(prompt).toContain('Visits last about an hour.');
    expect(prompt).toContain('How long does a visit take?');
    expect(prompt).not.toContain('Check the day they want before offering a window.');
  });
  it('an `after` of its own replaces the default line', () => {
    const own = build(JOURNEYS_YAML.replace('    actions: [availability, book]\n', '    actions: [availability, book]\n    after: The visit is booked; answer questions about it.\n'));
    const text = journeyText(own, s.journey!, {});
    expect(text).toContain('The visit is booked; answer questions about it.');
    expect(text).not.toContain('done on this call');
  });
  it('the tools hold no change action', () => {
    expect(names(withJourneys, s.journey)).toEqual(['availability', 'end_call']);
  });
});

describe('with a journey set aside', () => {
  const s = at({ ...root, active: 'note', paused: 'visit' });
  const prompt = systemPrompt(withJourneys, s, NOW);
  it('names its trigger and none of its facts', () => {
    expect(prompt).toContain(`Set aside earlier on this call: ${withJourneys.journeys!.visit!.when}; offer to pick it up once this is done.`);
    expect(prompt).not.toContain('Visits last about an hour.');
    expect(prompt).not.toContain('How long does a visit take?');
  });
});

describe('the order of the prompt', () => {
  it('the base information, then the five rules, then the journey text', () => {
    const prompt = systemPrompt(withJourneys, at({ ...root, active: 'visit' }), NOW);
    const at1 = prompt.indexOf(withJourneys.business.about);
    const rules = prompt.indexOf('Five rules hold on every call:');
    const journey = prompt.indexOf('What you are helping the caller with now');
    expect(at1).toBeGreaterThan(-1);
    expect(rules).toBeGreaterThan(at1);
    expect(journey).toBeGreaterThan(prompt.indexOf('5. What the caller tells you'));
  });
  it('a state without a journey field gets the prompt it always did', () => {
    expect(systemPrompt(withJourneys, fresh(), NOW)).toBe(systemPrompt(plain, fresh(), NOW));
  });
});

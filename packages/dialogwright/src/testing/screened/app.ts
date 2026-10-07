import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANONYMOUS, defineApp, handoff, type AppCode, type Completion, type CompletionContext, type Session, type ToolDef } from '../../index';
import { defineRule } from '../../define/policyEntry';

/**
 * Example Home Visits: a small, fictional line that books a free visit to look at a problem with a
 * home, written as an app folder. It is the engine's fixture for a form's checks (forms.yaml
 * `checks`, core/checks.ts): one form asks the qualifying answers first (the problem, whether the
 * caller owns the home, the town, how urgent it is), then the booking's (a day and a time of day),
 * and reads all of them back in one summary. Three checks, each an action of the policy with
 * `check: true`, run through the gate as soon as their answer is in: a renter, or a home outside the
 * four towns, hears that the visit is not for them and the call ends, before anything else is
 * asked; something urgent goes to the office. The booking names the same three rules, so the write
 * still refuses what a check refused. Something urgent said at any point is also a priority intent
 * (`urgent`), which takes the turn before any slot fills. All names and places are made up.
 */

/** The folder this app's YAML is in. */
export const SCREENED_DIR = dirname(fileURLToPath(import.meta.url));

/** The towns a visit can be in. */
export const TOWNS: readonly string[] = ['millbrook', 'cedar_falls', 'ashford', 'riverton'];

/** Params every rule example sends: what a booking sends, so the booking's confirmed rule passes and each rule decides. */
const QUALIFIES = { problem: 'leak', ownership: 'own', town: 'ashford', howUrgent: 'routine', visitDay: 'monday', timeOfDay: 'morning' } as const;

/** Something urgent goes to the office, not to a booking: NEEDS_HUMAN, reason `urgent`. */
export const urgentToOffice = defineRule({
  id: 'urgent-to-office',
  description: 'Something urgent goes to the office rather than to a booked visit',
  run: (c) => {
    const howUrgent = c.call.params.howUrgent ?? '';
    if (howUrgent === '') return { pass: false, compared: 'urgency not given', verdict: 'BLOCK', reason: 'urgency-unknown' };
    if (howUrgent === 'urgent') return { pass: false, compared: 'urgency urgent: to the office', verdict: 'NEEDS_HUMAN', reason: 'urgent' };
    return { pass: true, compared: `urgency ${howUrgent}: a visit can wait` };
  },
  examples: [
    { name: 'it can wait', call: { params: { ...QUALIFIES } }, principal: ANONYMOUS, expect: { verdict: 'ALLOW' } },
    { name: 'it is urgent', call: { params: { ...QUALIFIES, howUrgent: 'urgent' } }, principal: ANONYMOUS, expect: { verdict: 'NEEDS_HUMAN', reason: 'urgent' } },
    { name: 'no urgency given', call: { params: { ...QUALIFIES, howUrgent: '' } }, principal: ANONYMOUS, expect: { verdict: 'BLOCK', reason: 'urgency-unknown' } },
  ],
});

/** The visits are for homeowners: anyone else is refused, BLOCK `not-owner`. */
export const ownersOnly = defineRule({
  id: 'owners-only',
  description: 'The caller owns the home',
  run: (c) => (c.call.params.ownership === 'own'
    ? { pass: true, compared: 'ownership own' }
    : { pass: false, compared: `ownership ${c.call.params.ownership || 'not given'}: not the owner`, verdict: 'BLOCK', reason: 'not-owner' }),
  examples: [
    { name: 'an owner', call: { params: { ...QUALIFIES } }, principal: ANONYMOUS, expect: { verdict: 'ALLOW' } },
    { name: 'a renter', call: { params: { ...QUALIFIES, ownership: 'rent' } }, principal: ANONYMOUS, expect: { verdict: 'BLOCK', reason: 'not-owner' } },
  ],
});

/** The home is in one of the four towns: anywhere else is refused, BLOCK `out-of-area`. */
export const inArea = defineRule({
  id: 'in-area',
  description: 'The home is in Millbrook, Cedar Falls, Ashford or Riverton',
  run: (c) => {
    const town = c.call.params.town ?? '';
    return TOWNS.includes(town)
      ? { pass: true, compared: `town ${town}: in the area` }
      : { pass: false, compared: `town ${town || 'not given'}: outside the area`, verdict: 'BLOCK', reason: 'out-of-area' };
  },
  examples: [
    { name: 'a town in the area', call: { params: { ...QUALIFIES } }, principal: ANONYMOUS, expect: { verdict: 'ALLOW' } },
    { name: 'another town', call: { params: { ...QUALIFIES, town: 'elsewhere' } }, principal: ANONYMOUS, expect: { verdict: 'BLOCK', reason: 'out-of-area' } },
  ],
});

/** A visit booked on a call. */
export interface Visit {
  ref: string;
  day: string;
  timeOfDay: string;
}

/** The app's systems for one call: the visits booked so far, in memory. */
export class ScreenedSystems {
  readonly visits: Visit[] = [];
}

/** The slots the booking writes, in the order the confirmation hash is taken over. */
const BOOKED = ['problem', 'ownership', 'town', 'howUrgent', 'visitDay', 'timeOfDay'] as const;

/** Every tool: only the booking. The three checks are actions with no tool (policy.yaml `check: true`). */
export const TOOLS: Record<string, ToolDef> = {
  bookVisit: {
    params: [...BOOKED],
    run(call, sys) {
      const systems = sys as ScreenedSystems;
      const ref = `V${101 + systems.visits.length}`;
      systems.visits.push({ ref, day: call.params.visitDay ?? '', timeOfDay: call.params.timeOfDay ?? '' });
      return { value: { ref }, summary: `booked ${ref}`, ref };
    },
  },
};

/** The values the booking writes, read from the session: what the caller heard read back and said yes to. */
const visitParams = (s: Session): Record<string, string> => Object.fromEntries(BOOKED.map((id) => [id, s.slots[id]?.value ?? '']));

/** The form is full and confirmed: book the visit through the gate, and say so. */
function completeVisit(c: CompletionContext): Completion {
  const { s, acks } = c;
  s.confirmedHash = s.pendingHash;
  const { decision } = c.callTool({ tool: 'bookVisit', params: visitParams(s) });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  return { kind: 'end', promptId: 'visit_booked', vars: { visitDay: s.slots.visitDay?.display ?? '', timeOfDay: s.slots.timeOfDay?.display ?? '' }, acks };
}

/** The app's TypeScript parts. */
export const screenedCode: AppCode = {
  slots: {},
  tools: TOOLS,
  systems: () => ({ sys: new ScreenedSystems(), lookups: { ownerOf: () => null, scopeOf: () => [] } }),
  forms: {
    book_visit: { confirmedParams: visitParams, complete: completeVisit },
    // Something urgent, said as a request: straight to the office.
    urgent: { complete: (c) => ({ kind: 'decision', decision: handoff(c.s, 'urgent', c.acks) }) },
  },
  customRules: { 'urgent-to-office': urgentToOffice, 'owners-only': ownersOnly, 'in-area': inArea },
  testing: {
    heuristics: { intents: [['urgent', /\b(pouring|flooding|right now|emergency)\b/], ['book_visit', /\b(visit|leak|crack|draft|look at)\b/]] },
    seed: {
      caller: () => ANONYMOUS,
      placeholders: {
        problem: { value: 'leak', display: 'a leak' },
        ownership: { value: 'own', display: 'you own it' },
        town: { value: 'ashford', display: 'Ashford' },
        howUrgent: { value: 'routine', display: 'whenever suits' },
        visitDay: { value: 'monday', display: 'Monday' },
        timeOfDay: { value: 'morning', display: 'the morning' },
      },
      anythingElse: () => ({ form: 'book_visit' }),
    },
    policyMatrix: () => ({
      principals: {
        subject1: { kind: 'customer', level: 1, id: '55501234', first: 'Avery' },
        subject2: { kind: 'customer', level: 2, id: '55501234', first: 'Avery' },
        delegates: {},
        unlistedRole: { kind: 'staff', level: 2, id: 'S-1', first: 'Quinn', role: 'assistant' },
        roleless: { kind: 'staff', level: 2, id: 'S-2', first: 'Rowan' },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      records: {
        own: { subject: '55501234' },
        inScope: { subject: '55505678' },
        outOfScope: { subject: '55509012' },
        unknown: { subject: '55500000' },
      },
      calls: {
        checkUrgency: { routine: { howUrgent: 'routine' }, urgent: { howUrgent: 'urgent' } },
        checkOwner: { owner: { ownership: 'own' }, renter: { ownership: 'rent' } },
        checkArea: { inArea: { town: 'riverton' }, elsewhere: { town: 'elsewhere' } },
      },
      values: { problem: 'leak', ownership: 'own', town: 'ashford', howUrgent: 'routine', visitDay: 'monday', timeOfDay: 'morning' },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const screenedApp = defineApp(SCREENED_DIR, screenedCode);

/** The code parts under the name `dialogwright check` imports them by. */
export const code = screenedCode;

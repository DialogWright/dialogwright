import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync as read } from 'node:fs';
import { agentBusinessProblems } from '../converse/business/load';
import { CONVERSE_FIXTURE_DIR, converseFixture } from '../testing/converse/app';
import { ACCOUNT_JOURNEYS_YAML, JOURNEYS_YAML, LEAVE_NOTE_ACTION } from '../testing/converse/journeys';
import { conversePolicyCardText, conversePolicyMatrixText, converseAppMapText } from '../testing/conversePages';
import { workspaceCopy, type WorkspaceCopy } from './__fixtures__/workspaceCopy';
import { main } from './cli';
import { workspaceRootOf } from './matrixCommand';

/**
 * The pages of a converse app, written from agent.yaml's actions: what each says of the fixture's actions, and
 * the three commands (policy:matrix, policy:card, app:diagram) finding a converse app's folder and writing its
 * pages only when they changed. The commands run on a scratch copy of apps/wheelshop-agent: no test writes a
 * committed page.
 */

const ROOT = workspaceRootOf(dirname(fileURLToPath(import.meta.url)));
const SHOP = 'apps/wheelshop-agent';
const PAGES = ['policy.matrix', 'POLICY.md', 'APP-MAP.md'];

const copies: WorkspaceCopy[] = [];
afterEach(() => {
  for (const copy of copies.splice(0)) copy.remove();
});

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err };
}

function scratch(): string {
  const copy = workspaceCopy(ROOT, [SHOP]);
  copies.push(copy);
  return copy.root;
}

describe('the pages of a converse app', () => {
  const { app } = converseFixture();

  it('the matrix: a lookup is open, a change runs only with the caller\'s yes to exactly its values', () => {
    const text = conversePolicyMatrixText(app);
    expect(text).toMatch(/^availability · level 0 · no rules\n {2}every caller {2}ALLOW$/m);
    expect(text).toMatch(/^book · level 0 · confirmed\(.*\)\n {2}every caller {2}confirmed none\|mismatch {2}BLOCK confirmation\n +confirmed match +ALLOW$/m);
    expect(text).toContain('(unlisted)');
  });

  it('the card: each action with its kind, read-back and the confirmation every change needs', () => {
    const text = conversePolicyCardText(app);
    expect(text).toContain('# Policy card:');
    expect(text).toContain('| `availability` | lookup | yes | none | none |');
    expect(text).toMatch(/\| `book` \| change \| yes \| `confirmed\(/);
    expect(text).toContain('Read back before it runs, in these words:');
    expect(text).toContain('the caller\'s yes to a read-back of');
    expect(text).toContain('The agent model is sent, in full');
    expect(text).toContain('Nothing checks an action\'s result');
    expect(text).toContain('only by its last four digits');
  });

  it('the card: a business with opening hours says what the model is told and the after-hours greeting; one without keeps its card', () => {
    const base = read(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), 'utf8');
    const open = agentBusinessProblems(base.replace('business:\n', 'business:\n  open:\n    weekly: { mon-fri: ["08:00-17:00"] }\n').replace('lines:\n', 'lines:\n  greetingAfterHours: { en: "We are closed." }\n')).value!;
    const card = conversePolicyCardText({ ...app, business: open });
    expect(card).toContain('is told, on every request, whether the business is open now');
    expect(card).toContain('when it closes or next opens');
    expect(card).toContain('is told never to promise a callback for a time the business information does not give');
    expect(card).toContain('`lines.greetingAfterHours`, word for word, in place of the greeting (and of a journey\'s): "We are closed."');
    expect(conversePolicyCardText(app)).not.toContain('greetingAfterHours');
    expect(conversePolicyCardText(app)).not.toContain('whether the business is open now');
  });

  it('the card: only the audit records an action\'s result, and only a gate refusal is scrubbed before the model is told it', () => {
    const text = conversePolicyCardText(app);
    expect(text).toContain('Only the audit records an action\'s result');
    expect(text).not.toMatch(/The trace and the audit record each action's params[^\n]*and an action's result/);
    expect(text).toContain('Only the reason the gate refused a call is scrubbed');
    expect(text).toContain('go to the agent model as written');
  });

  it('the card: what the decision model is sent: each read-back with the caller\'s words in answer, and the business\'s day', () => {
    const text = conversePolicyCardText(app);
    expect(text).toContain('- The decision model (not the agent model) is sent each read-back as it was said, the caller\'s own words in answer to it and the business\'s day (today\'s date, in words), to read a yes or a no.');
    expect(text).toContain('it is also sent the business information, the business\'s day, the call\'s actions so far');
    expect(text).toContain('any words of the caller\'s that imitate the note\'s mark are rewritten before the agent model is sent them');
  });

  it('the card: the caller\'s own words are kept as said, and a text param shows its bound', () => {
    const text = conversePolicyCardText(app);
    expect(text).toContain('- The caller\'s own words, typed or spoken, are kept as they said them in the trace and the frame log, as in the scripted mode.');
    expect(text).toContain('| `name` | text (one line, at most 120 characters) | ');
    const { app: bounded } = converseFixture(); // a fresh copy, given its own bound
    bounded.business.actions.book!.params.name!.max = 40;
    expect(conversePolicyCardText(bounded)).toContain('| `name` | text (one line, at most 40 characters) | ');
  });

  it('the map: the actions and where a slot value must come from', () => {
    const text = converseAppMapText(app);
    expect(text).toContain('```mermaid');
    expect(text).toMatch(/a_availability -->\|\w+\| a_book/);
  });
});

/** The fixture app with its agent.yaml edited (`edit` on the text), as a copy: the pages are written from the business. */
function edited(edit: (text: string) => string): ReturnType<typeof converseFixture>['app'] {
  const { app } = converseFixture();
  const { value, problems } = agentBusinessProblems(edit(read(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), 'utf8')));
  if (!value) throw new Error(problems.map((p) => p.message).join('\n'));
  return { ...app, business: value };
}

describe('an edit to agent.yaml changes the pages', () => {
  const { app } = converseFixture();
  const rule = (r: string) => (t: string): string => t.replace('    audit: { name: length, phone: last4 }', `    rules:\n${r}\n    audit: { name: length, phone: last4 }`);

  it('a rule: a list is tried value by value, a bound at and beyond it', () => {
    const listed = edited(rule('      - oneOf: { field: name, values: [ann, bo], reason: not-listed }'));
    const matrix = conversePolicyMatrixText(listed);
    expect(matrix).toContain('oneOf(name: ann, bo)');
    for (const v of ['name ann', 'name bo', 'name another value']) expect(matrix).toContain(v);
    expect(conversePolicyCardText(listed)).toContain('name must be one of ann, bo (refused as not-listed)');
    expect(matrix).not.toBe(conversePolicyMatrixText(app));
    const bounded = edited(rule('      - dateInRange: { field: window, notAfter: "2026-12-31" }'));
    const bm = conversePolicyMatrixText(bounded);
    expect(bm).toContain('2026-12-31');
    expect(bm).toContain('2027-01-01');
    expect(conversePolicyCardText(bounded)).toContain('not after 2026-12-31');
    expect(conversePolicyCardText(edited(rule('      - dateInRange: { field: window, notAfter: "2026-12-30" }')))).not.toBe(conversePolicyCardText(bounded));
  });

  it('a read-back: the card prints it', () => {
    const card = conversePolicyCardText(edited((t) => t.replace('Is that right?', 'Does that sound right?')));
    expect(card).toContain('Does that sound right?');
    expect(card).not.toBe(conversePolicyCardText(app));
  });

  it('a follow-on: the card and the map show it, and print no read-back for it', () => {
    const text = (t: string): string => t.replace('    audit: { name: length, phone: last4 }\n', '    audit: { name: length, phone: last4 }\n    then: [tell]\n') + '  tell:\n    about: Tell.\n    kind: change\n    params:\n      name: { type: text, about: n. }\n    readBack:\n      en: "NEVER-SAID {name}."\n';
    const withThen = edited(text);
    const card = conversePolicyCardText(withThen);
    expect(card).toContain('no: follows `book`');
    expect(card).not.toContain('NEVER-SAID');
    expect(card).toContain('it has no read-back of its own');
    expect(converseAppMapText(withThen)).toMatch(/a_book ==>\|[^|]*\| a_tell/);
  });
});

describe('dialogwright policy:matrix, policy:card and app:diagram on a converse app', () => {
  it('write nothing when the pages are what the app generates', async () => {
    const root = scratch();
    for (const [command, file] of [['policy:matrix', 'policy.matrix'], ['policy:card', 'POLICY.md'], ['app:diagram', 'APP-MAP.md']] as const) {
      const run = io(root);
      expect(await main([command, SHOP], run.io)).toBe(0);
      expect(run.err).toEqual([]);
      expect(run.out).toEqual([`${SHOP}/${file}: unchanged`]);
    }
  });

  it('write a page that changed, as the app generates it', async () => {
    const root = scratch();
    for (const file of PAGES) writeFileSync(join(root, SHOP, file), 'stale\n');
    for (const command of ['policy:matrix', 'policy:card', 'app:diagram']) {
      const run = io(root);
      expect(await main([command, SHOP], run.io)).toBe(0);
      expect(run.out).toEqual([expect.stringMatching(/^wrote apps\/wheelshop-agent\/.* \(\d+ lines\): review the diff before you commit it$/)]);
    }
    for (const file of PAGES) expect(readFileSync(join(root, SHOP, file), 'utf8')).toBe(readFileSync(join(ROOT, SHOP, file), 'utf8'));
  });
});

describe('the pages of a converse app with journeys', () => {
  const { app: plain } = converseFixture();
  const withJourneys = (yaml: string) => {
    const { value, problems } = agentBusinessProblems(read(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), 'utf8') + LEAVE_NOTE_ACTION + yaml);
    expect(problems).toEqual([]);
    return { ...plain, business: value! };
  };
  const app = withJourneys(JOURNEYS_YAML);

  it('the card lists, for each action, the journeys that offer it, and a section for the journeys', () => {
    const text = conversePolicyCardText(app);
    expect(text).toMatch(/\| `book` \| change \| yes \| `visit` \|/);
    expect(text).toMatch(/\| `leave_note` \| change \| yes \| `note` \|/);
    expect(text).toContain('## Journeys');
    expect(text).toContain('The caller wants a visit booked, or wants to know about one.');
    expect(text).toContain('Open to every caller.');
  });

  it('the card says at the root for a lookup the root offers, and who a journey is open to and starts for', () => {
    const rooted = withJourneys(JOURNEYS_YAML.replace('root:\n', 'root:\n  actions: [availability]\n'));
    expect(conversePolicyCardText(rooted)).toMatch(/\| `availability` \| lookup \| yes \| at the root, `visit` \|/);
    const text = conversePolicyCardText(withJourneys(ACCOUNT_JOURNEYS_YAML));
    expect(text).toContain('Open only where the number calling is on an account. Starts the call there.');
    expect(text).toContain('Open only where the number calling is on no account.');
  });

  it('the map has a journeys subgraph: root, journeys, their actions and follow-ons', () => {
    const text = converseAppMapText(app);
    expect(text).toContain('subgraph journeys["Journeys"]');
    expect(text).toMatch(/j_visit .*-->.* a_book/);
    expect(text).toMatch(/root.*-->.*j_visit/s);
  });

  it('the card says what routing sends the decision model: each caller turn\'s words, the line\'s last reply, the open journeys\' triggers, and a finished journey\'s goal', () => {
    const text = conversePolicyCardText(app);
    const sent = text.slice(text.indexOf('## What a model is sent'), text.indexOf('## Journeys'));
    expect(sent).toMatch(/For routing among the journeys, the decision model is also sent each caller turn's words, the line's last reply before them .*, and the trigger \(`when`\) of each journey open to the caller/);
    expect(sent).toMatch(/In a finished journey's after phase, the decision model is also sent the finished journey's goal/);
    expect(conversePolicyCardText(plain)).not.toContain('For routing');
  });

  it('the routing words are short bullets, one idea each', () => {
    const text = conversePolicyCardText(app);
    const sent = text.slice(text.indexOf('## What a model is sent'), text.indexOf('## Journeys'));
    const bullets = sent.split('\n').filter((l) => /routing|unclear|fits/.test(l));
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    for (const l of bullets) expect(l.length).toBeLessThan(420);
  });

  it('the card says the agent model in a journey is sent the other open journeys\' triggers, and lists a journey\'s greeting', () => {
    const text = conversePolicyCardText(app);
    const sent = text.slice(text.indexOf('## What a model is sent'), text.indexOf('## Journeys'));
    expect(sent).toMatch(/In a journey in progress, the agent model is also sent the trigger \(`when`\) of each other journey open to the caller/);
    expect(text).not.toMatch(/Greeting:/);
    const acct = conversePolicyCardText(withJourneys(ACCOUNT_JOURNEYS_YAML.replace('    start: { account: recognised }\n', '    start: { account: recognised }\n    greeting: { en: "Welcome back." }\n')));
    expect(acct).toContain('- Greeting, said word for word where it starts the call: "Welcome back."');
    expect(conversePolicyCardText(plain)).not.toContain('other journey open');
  });

  it('the card names the fits question, the bars, the unclear line and what an unclear turn withholds', () => {
    const text = conversePolicyCardText(app);
    const sent = text.slice(text.indexOf('## What a model is sent'), text.indexOf('## Journeys'));
    expect(sent).toMatch(/whether the caller's turn has anything to do with the task \(`fits`\)/);
    expect(sent).not.toMatch(/gives what the line just asked for|reaches no journey/);
    expect(sent).toMatch(/At the root, a turn is unclear only when none is the top reading/);
    expect(sent).toMatch(/`routing\.startAt`/);
    expect(sent).toMatch(/`routing\.switchAt`/);
    expect(sent).toMatch(/`business\.line`/);
    const journeys = text.slice(text.indexOf('## Journeys'));
    expect(journeys).toContain("Sorry, I can't follow that. Please call back any time.");
    expect(journeys).toMatch(/`lines\.unclear`/);
    expect(journeys).toMatch(/unclear turn.*change action is withheld|change actions are withheld/);
    expect(journeys).toMatch(/lookups/);
    expect(conversePolicyCardText(plain)).not.toContain('unclear');
  });

  it('the card says which actions end a journey, and that one with an empty completes is never done', () => {
    const own = conversePolicyCardText(withJourneys(JOURNEYS_YAML.replace('    actions: [availability, book]\n', '    actions: [availability, book]\n    completes: [book]\n')));
    expect(own).toContain('- Done when `book` runs on the caller\'s yes.');
    const never = conversePolicyCardText(withJourneys(JOURNEYS_YAML.replace('    actions: [availability, book]\n', '    actions: [availability, book]\n    completes: []\n')));
    expect(never).toContain('- Never done: no action ends it, so it stays in progress after each change runs on the caller\'s yes.');
    expect(never).not.toMatch(/Done when +runs/);
  });

  it('the card says a lookup no journey and not the root names is not offered to the model', () => {
    const hours = '  hours:\n    about: The hours on a day.\n    kind: lookup\n    params:\n      day: { type: date, about: The day. }\n';
    const { value, problems } = agentBusinessProblems(read(join(CONVERSE_FIXTURE_DIR, 'agent.yaml'), 'utf8') + LEAVE_NOTE_ACTION + hours + JOURNEYS_YAML);
    expect(problems).toEqual([]);
    const text = conversePolicyCardText({ ...plain, business: value! });
    expect(text).toMatch(/\| `hours` \| lookup \| no: named by no journey \| none \|/);
    expect(text).toMatch(/\| `availability` \| lookup \| yes \| `visit` \|/);
  });

  it('an app without journeys has the same pages as before: no section, no column, no diagram', () => {
    const card = conversePolicyCardText(plain);
    const map = converseAppMapText(plain);
    expect(card).not.toContain('Journeys');
    expect(card).toContain('| Action | Kind | Offered to the model | Rules | Follow-on actions |');
    expect(map).not.toContain('journeys');
  });
});

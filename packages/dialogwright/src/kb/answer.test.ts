import { afterAll, describe, expect, it } from 'vitest';
import { VOICE_RELAY } from '../channel/caps';
import { keyEvents } from '../channel/events';
import { gateOf } from '../core/app/lookup';
import type { KbSource } from '../core/lifecycle';
import { newSession } from '../core/session';
import { resolve, type TurnResult } from '../core/turn';
import { checkApp } from '../define/check';
import { isAppDefinitionError } from '../define/defineApp';
import { formatProblem } from '../define/problems';
import { ANONYMOUS } from '../gate/principal';
import { spokenText } from '../prompts/render';
import { choice, noul } from '../testing/answers';
import { appMapText, danglingReferences } from '../testing/appMap';
import { registerTestkit, testkitApp } from '../testing/testkit';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { fillAccountLine, kbCallParams, readKbAnswer } from './answer';
import { approvalHashOf, sourceHashOf } from './hash';
import { APP_EDITS, ask, call, calls, cleanScratch, codeFor, folder, heard, kbRows, libraryKbApp, say, TODAY, type Call, type Edit } from './__fixtures__/libraryKbApp';

/**
 * Speaking an answer from the knowledge base, on Example Town Library's line with its knowledge base
 * (./__fixtures__/kb) as kb/ (./__fixtures__/libraryKbApp.ts): a form that answers (forms.yaml
 * `answers:`, the engine's completion) through findPassage with the late fees' account line read
 * through getFees, and the opening hours as an informational intent's passage.
 */

afterAll(cleanScratch);

const APP = libraryKbApp('library-kb');

describe('a form that answers from the knowledge base (forms.yaml answers:)', () => {
  it('passes check as it is: the folder, its knowledge base, its lines in both languages, and the code', async () => {
    const dir = folder('library-kb-check');
    expect((await checkApp(dir, { code: codeFor(dir), todayIso: TODAY })).map(formatProblem)).toEqual([]);
    // The app map draws the intent to its passage, and nothing it names is missing.
    expect(danglingReferences(APP)).toEqual([]);
    expect(appMapText(APP)).toContain('passage opening-hours');
  });

  it('says the answer word for word, with the account line from the caller\'s own data, and records the passage', () => {
    const c = call(APP);
    const r = ask(c, 'late_fees');
    expect(heard(c)).toBe(
      'Sure, I can help you answer a question. Late books on an adult card cost 25 cents a day, up to 5 dollars a book. Your card has 2 dollars in late fees right now. Is there anything else I can help with?',
    );
    // The answer, then the account line, each through the gate; the card kind is the library's record, not a param.
    expect(calls(r)).toEqual(['findPassage(topic=late_fees) ALLOW: late-fees-adult', 'getFees(topic=late_fees) ALLOW: fees read']);
    const kb = APP.knowledge!.kb!;
    const passage = kb.passages['late-fees-adult']!;
    expect(r.kb).toEqual({
      passageId: 'late-fees-adult', topic: 'late_fees', version: '2026.1', applies: { card: 'adult' }, locale: 'en-US',
      document: 'Example Town Library Patron Guide', section: '3.1', effectiveFrom: '2026-01-01',
      approvedBy: 'Branch Manager', approvedOn: '2025-12-10',
      sourceHash: passage.approval!.sourceHash.slice(0, 12), approvalHash: passage.approval!.hash.slice(0, 12), fresh: true,
    } satisfies KbSource);
    // One kb_answer row, from findPassage's audit hook, naming the passage and its hashes and nothing of the caller's.
    expect(kbRows(r)).toEqual([{ type: 'kb_answer', detail: { passageId: 'late-fees-adult', version: '2026.1', fresh: true, locale: 'en-US', sourceHash: passage.approval!.sourceHash.slice(0, 12), approvalHash: passage.approval!.hash.slice(0, 12) } }]);
    expect(r.audit.map((d) => d.type)).toEqual(['gate', 'tool_result', 'kb_answer', 'gate', 'tool_result']);
    expect(r.session.completed).toEqual(['ask_library']);
  });

  it('answers for the caller\'s card as the records say it, and a topic with no account line with the answer alone', () => {
    const junior = call(APP, { setup: (sys) => { sys.cardKind = 'junior'; } });
    ask(junior, 'late_fees');
    expect(heard(junior)).toContain('There are no late fees on a junior card. Your card has 2 dollars in late fees right now.');
    const renewal = call(APP);
    const r = ask(renewal, 'card_renewal');
    expect(heard(renewal)).toBe('Sure, I can help you answer a question. An adult card lasts three years. To renew it, bring a photo ID to any branch desk. There\'s no charge. Is there anything else I can help with?');
    expect(calls(r)).toEqual(['findPassage(topic=card_renewal) ALLOW: card-renewal-adult']);
  });

  it('says the answer without the account line when its read is refused, or comes back without the value the line needs', () => {
    // A gate that refuses getFees: the answer stands on its own.
    const base = gateOf(APP);
    const refusing = libraryKbApp('library-kb-refusing');
    Object.assign(refusing, { gate: { ...base, source: base.source, tables: base.tables, subjectKind: base.subjectKind, identityTools: base.identityTools, evaluate: (...args: Parameters<typeof base.evaluate>) => {
      const d = base.evaluate(...args);
      return args[0].tool === 'getFees' ? { ...d, verdict: 'BLOCK' as const, reason: 'scope' } : d;
    } } });
    const c = call(refusing);
    const r = ask(c, 'late_fees');
    expect(heard(c)).toBe('Sure, I can help you answer a question. Late books on an adult card cost 25 cents a day, up to 5 dollars a book. Is there anything else I can help with?');
    expect(calls(r)).toEqual(['findPassage(topic=late_fees) ALLOW: late-fees-adult', 'getFees(topic=late_fees) BLOCK']);
    expect(r.kb?.passageId).toBe('late-fees-adult');

    const none = call(APP, { setup: (sys) => { sys.balance = null; } });
    ask(none, 'late_fees');
    expect(heard(none)).toBe('Sure, I can help you answer a question. Late books on an adult card cost 25 cents a day, up to 5 dollars a book. Is there anything else I can help with?');
  });

  it('says in another language the passage in that language, and the account line in it', () => {
    const answer = 'Los libros atrasados con una tarjeta de adulto cuestan 25 centavos al día, hasta 5 dólares por libro.';
    const sourceText = 'An adult card is charged 25 cents for each day an item is overdue, up to 5 dollars for each item.';
    const hash = approvalHashOf({ id: 'late-fees-adult-es', locale: 'es', version: '2026.1', topic: 'late_fees', title: 'Late fees', localeTitle: 'Multas por retraso', answer, applies: { card: ['adult'] }, effective: { from: '2026-01-01' }, sourceText, accountLineText: 'Su tarjeta tiene {balance} en multas ahora mismo.' });
    const app = libraryKbApp('library-kb-es', {
      'kb/locale/es/passages/late-fees-adult-es.yaml': [
        'id: late-fees-adult-es', 'topic: late_fees', 'version: "2026.1"', 'applies: { card: adult }', 'effective: { from: 2026-01-01 }',
        'source: { document: patron-guide, section: "3.1" }', `answer: ${answer}`, 'translates: late-fees-adult',
        'approval:', '  owner: Patron Services', '  approvedBy: Branch Manager', '  on: 2025-12-10', `  sourceHash: ${sourceHashOf(sourceText)}`, `  hash: ${hash}`, '',
      ].join('\n'),
    });
    const c = call(app, { locale: 'es' });
    const r = ask(c, 'late_fees');
    expect(heard(c)).toBe(`Claro, puedo ayudarle a answer a question. ${answer} Su tarjeta tiene 2 dollars en multas ahora mismo. ¿Hay algo más en que pueda ayudarle?`);
    expect(r.kb).toMatchObject({ passageId: 'late-fees-adult-es', locale: 'es', applies: { card: 'adult' }, fresh: true });
    // A topic with a Spanish passage and no Spanish account line would be answered without the line: here, the late fees' line is translated.
    expect(calls(r)).toEqual(['findPassage(topic=late_fees) ALLOW: late-fees-adult-es', 'getFees(topic=late_fees) ALLOW: fees read']);
  });
});

describe('no answer to give: the unavailable line, and a person offered once', () => {
  it('a passage edited after its approval is withheld (stale), and recorded as not fresh', () => {
    const app = libraryKbApp('library-kb-stale', { 'kb/passages/late-fees-adult.yaml': (t) => t.replace('25 cents a day', '30 cents a day') });
    const c = call(app);
    const r = ask(c, 'late_fees');
    expect(heard(c)).toBe('Sure, I can help you answer a question. I\'m sorry, I don\'t have an answer to that I can give you right now. Would you like me to connect you to a librarian, or keep going?');
    expect(calls(r)).toEqual(['findPassage(topic=late_fees) ALLOW: no passage (stale)']);
    expect(r.kb).toMatchObject({ passageId: 'late-fees-adult', fresh: false });
    expect(kbRows(r)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ passageId: 'late-fees-adult', fresh: false }) })]);
    expect(r.session.pendingConfirmation).toEqual({ target: 'transfer', attempts: 0, after: 'ask_library', why: 'no-answer' });
  });

  it('none in force on the day: the line and the offer; a yes is a person', () => {
    const c = call(APP, { today: '2025-06-01' });
    const r = ask(c, 'card_renewal');
    expect(calls(r)).toEqual(['findPassage(topic=card_renewal) ALLOW: no passage (not-in-force)']);
    expect(r.kb).toBeNull();
    expect(heard(c)).toContain('I\'m sorry, I don\'t have an answer to that I can give you right now. Would you like me to connect you to a librarian, or keep going?');
    const yes = say(c, 'yes please', { confirmsYes: noul(0.95), confirmsNo: noul(0.03) });
    expect(yes.decision.kind).toBe('handoff');
  });

  it('a yes to the offer is a request for a person, not a frustrated caller: plain, or "connect me to a person"', () => {
    const offered = (): Call => {
      const c = call(APP, { today: '2025-06-01' });
      ask(c, 'card_renewal');
      return c;
    };
    const handoffOf = (r: TurnResult) => ({ kind: r.decision.kind, reason: (r.decision as { reason?: string }).reason, promptId: (r.decision as { promptId?: string }).promptId });
    // A plain yes: the confirmation gate.
    expect(handoffOf(say(offered(), 'yes please', { confirmsYes: noul(0.95), confirmsNo: noul(0.03) }))).toEqual({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent' });
    // "Yes, connect me to a person": the wants-human gate sees it first, and says the same.
    expect(handoffOf(say(offered(), 'yes, connect me to a person', { confirmsYes: noul(0.95), confirmsNo: noul(0.03), wantsHuman: noul(0.95) }))).toEqual({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent' });
  });

  it('no facts on record: the same line and offer; declined, the form ends, and a second question with no answer is not offered a person again', () => {
    const c = call(APP, { setup: (sys) => { sys.cardKind = null; } });
    expect(calls(ask(c, 'late_fees'))).toEqual(['findPassage(topic=late_fees) ALLOW: no passage (no-facts)']);
    expect(heard(c)).toContain('Would you like me to connect you to a librarian, or keep going?');
    const no = say(c, 'no thanks', { confirmsYes: noul(0.03), confirmsNo: noul(0.95) });
    expect(no.session.transferDeclined).toBe(true);
    expect(no.session.form).toBeNull();
    expect(no.session.completed).toEqual([]);
    const again = ask(c, 'card_renewal');
    expect(heard(c, again)).toBe('Sure, I can help you answer a question. I\'m sorry, I don\'t have an answer to that I can give you right now. Is there anything else I can help with?');
    expect(again.session.pendingConfirmation).toBeNull();
  });

  it('no translation in the caller\'s language, with the fallback none: the line in that language, and the offer', () => {
    const c = call(APP, { locale: 'es' });
    const r = ask(c, 'card_renewal');
    expect(calls(r)).toEqual(['findPassage(topic=card_renewal) ALLOW: no passage (no-translation)']);
    expect(heard(c)).toContain('Lo siento, ahora no tengo una respuesta que pueda darle. ¿Quiere que le comunique con un bibliotecario, o seguimos?');
    // With the fallback default, the default language's passage is said.
    const fallback = libraryKbApp('library-kb-fallback', { 'kb/kb.yaml': (t) => t.replace('localeFallback: none', 'localeFallback: default') });
    const f = call(fallback, { locale: 'es' });
    ask(f, 'card_renewal');
    expect(heard(f)).toContain('An adult card lasts three years.');
  });
});

describe('an informational intent that says a passage (intents.yaml passage:)', () => {
  const hours = (c: Call): TurnResult => say(c, 'when are you open', { intent: choice({ hours: 0.95, none: 0.05 }) });

  it('says the passage in force, word for word, with no gate, and records it with its audit row', () => {
    const c = call(APP);
    const r = hours(c);
    expect(heard(c)).toBe('We\'re open Monday to Friday from 9 in the morning to 8 at night, and Saturday from 10 to 4. We\'re closed on Sunday. How can I help you today?');
    expect(r.gateEvents).toEqual([]);
    expect(r.kb).toMatchObject({ passageId: 'opening-hours', topic: 'opening_hours', applies: {}, locale: 'en-US', fresh: true });
    expect(kbRows(r)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ passageId: 'opening-hours', fresh: true }) })]);
  });

  it('says it in the caller\'s language where it is translated, and on the keypad menu\'s key the same', () => {
    const c = call(APP, { locale: 'es' });
    const r = hours(c);
    expect(heard(c)).toBe('Abrimos de lunes a viernes de 9 de la mañana a 8 de la noche, y los sábados de 10 a 4. Los domingos cerramos. ¿En qué puedo ayudarle hoy?');
    expect(r.kb).toMatchObject({ passageId: 'opening-hours-es', locale: 'es' });
  });

  it('none to say: the unavailable line and a person offered, once; declined, the caller is back where they were', () => {
    const c = call(APP, { today: '2025-06-01' });
    const r = hours(c);
    expect(heard(c)).toBe('I\'m sorry, I don\'t have an answer to that I can give you right now. Would you like me to connect you to a librarian, or keep going?');
    expect(r.kb).toBeNull();
    expect(r.session.pendingConfirmation).toEqual({ target: 'transfer', attempts: 0, why: 'no-answer' });
    const no = say(c, 'no', { confirmsYes: noul(0.03), confirmsNo: noul(0.95) });
    expect(no.session.transferDeclined).toBe(true);
    expect(heard(c, no)).toContain('How can I help you today?');
    hours(c);
    expect(heard(c)).toBe('I\'m sorry, I don\'t have an answer to that I can give you right now. How can I help you today?');
  });

  it('a yes to the offer is a request for a person, not a frustrated caller\'s handoff', () => {
    const c = call(APP, { today: '2025-06-01' });
    hours(c);
    const yes = say(c, 'yes please', { confirmsYes: noul(0.95), confirmsNo: noul(0.03) });
    expect(yes.decision).toMatchObject({ kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent' });
    expect(yes.audit.filter((a) => a.type === 'handoff')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ reason: 'live-agent' }) })]);
  });

  it('a stale passage is withheld and recorded as not fresh', () => {
    const app = libraryKbApp('library-kb-stale-hours', { 'kb/sources/patron-guide.yaml': (t) => t.replace('from 9 a.m. to 8 p.m.', 'from 9 a.m. to 9 p.m.') });
    const c = call(app);
    const r = hours(c);
    expect(heard(c)).toContain('I\'m sorry, I don\'t have an answer to that I can give you right now.');
    expect(r.kb).toMatchObject({ passageId: 'opening-hours', fresh: false });
    expect(kbRows(r)).toHaveLength(1);
  });

  it('the keypad: a menu key for the intent says the passage as the spoken intent does', () => {
    const app = libraryKbApp('library-kb-menu', { 'intents.yaml': (t) => APP_EDITS['intents.yaml']!(t).replace('  - digit: "0"\n', '  - digit: "3"\n    intent: hours\n  - digit: "0"\n') });
    const c = call(app);
    c.last.session.menuActive = true;
    const [key] = keyEvents('3');
    const r = resolve(c.last.session, key!, null, c.t);
    expect(spokenText(app, r.decision, r.session.locale)).toMatch(/^We're open Monday to Friday/);
    expect(r.kb?.passageId).toBe('opening-hours');
  });
});

describe('the pieces', () => {
  it('reads a resolving tool\'s value as an answer only when it has text and a fresh record', () => {
    const source: KbSource = { passageId: 'p', topic: 't', version: '1', applies: {}, document: 'd', section: 's', effectiveFrom: '2026-01-01', fresh: true };
    expect(readKbAnswer({ answer: 'Yes.', source })).toEqual({ answer: 'Yes.', source });
    expect(readKbAnswer({ answer: 'Yes.', source: { ...source, fresh: false } })).toEqual({ unavailable: 'stale', source: { ...source, fresh: false } });
    expect(readKbAnswer({ answer: '  ', source })).toEqual({ unavailable: 'no-answer' });
    expect(readKbAnswer({ answer: 'Yes.' })).toEqual({ unavailable: 'no-answer' });
    expect(readKbAnswer(null)).toEqual({ unavailable: 'no-answer' });
    expect(readKbAnswer('Yes.')).toEqual({ unavailable: 'no-answer' });
    expect(readKbAnswer({ unavailable: 'not-in-force' })).toEqual({ unavailable: 'not-in-force' });
  });

  it('fills an account line from the result\'s fields, and leaves it out when one is missing, null or withheld', () => {
    expect(fillAccountLine('You have {count} left, of {total}.', { count: 3, total: '10' })).toBe('You have 3 left, of 10.');
    expect(fillAccountLine('You have {count} left.', { count: null })).toBeNull();
    expect(fillAccountLine('You have {count} left.', {})).toBeNull();
    expect(fillAccountLine('You have {count} left.', { count: '' })).toBeNull();
    expect(fillAccountLine('You have {count} left.', { count: { n: 1 } })).toBeNull();
    expect(fillAccountLine('You have {count} left.', null)).toBeNull();
    expect(fillAccountLine('You have {count} left.', 3)).toBeNull();
  });

  it('gives a knowledge read the subject\'s id under the param its scope rule names, for an app that verifies callers', () => {
    registerTestkit();
    const own = newSession('kb-subject', 0, VOICE_RELAY, customerPrincipal(CUSTOMERS[0]!, 1), testkitApp.id);
    expect(kbCallParams(testkitApp, own, 'getAccount', 'returns')).toEqual({ accountId: '55501234', topic: 'returns' });
    // Anyone else is named by no id: the scope rule refuses them.
    expect(kbCallParams(testkitApp, newSession('kb-anon', 0, VOICE_RELAY, ANONYMOUS, testkitApp.id), 'getAccount', 'returns')).toEqual({ accountId: '', topic: 'returns' });
    // A tool scoped by a record names no subject: the topic alone.
    expect(kbCallParams(testkitApp, own, 'getParcel', 'returns')).toEqual({ topic: 'returns' });
  });

  it('gives a knowledge read the topic alone for an app that verifies no one', () => {
    const c = call(APP);
    expect(kbCallParams(APP, c.last.session, 'findPassage', 'late_fees')).toEqual({ topic: 'late_fees' });
  });
});

describe('check: a folder\'s knowledge answers', () => {
  async function lines(id: string, edits: Record<string, Edit>): Promise<string[]> {
    const dir = folder(id, edits);
    try {
      return (await checkApp(dir, { code: codeFor(dir), todayIso: TODAY })).map(formatProblem);
    } catch (error) {
      if (isAppDefinitionError(error)) return error.problems.map(formatProblem);
      throw error;
    }
  }

  it('an intent\'s passage that does not exist, is a translation, or has a passage for some callers only', async () => {
    expect(await lines('kb-c1', { 'intents.yaml': (t) => APP_EDITS['intents.yaml']!(t).replace('passage: opening-hours', 'passage: opening-hour') })).toEqual([
      'intents.yaml:19:14  intents.hours.passage  intent "hours" says the passage "opening-hour", which kb/passages does not have  ->  rename it to "opening-hours", or add kb/passages/opening-hour.yaml, then review and approve it',
    ]);
    expect(await lines('kb-c2', { 'intents.yaml': (t) => APP_EDITS['intents.yaml']!(t).replace('passage: opening-hours', 'passage: opening-hours-es') })).toEqual([
      'intents.yaml:19:14  intents.hours.passage  intent "hours" says the passage "opening-hours-es", which is in es; an intent names the default locale\'s passage (en-US), and a call in another language hears its translation  ->  name the passage it translates ("opening-hours")',
    ]);
    expect(await lines('kb-c3', { 'intents.yaml': (t) => APP_EDITS['intents.yaml']!(t).replace('passage: opening-hours', 'passage: card-renewal-adult') })).toEqual([
      'intents.yaml:19:14  intents.hours.passage  intent "hours" says the passage "card-renewal-adult", whose topic "card_renewal" has a passage for some callers only ("card-renewal-adult": card adult); an informational intent\'s answer is for every caller, read with no gate  ->  take the applies out of kb/passages/card-renewal-adult.yaml, or answer "card_renewal" through a form that answers from the knowledge base (forms.yaml answers:), whose gated read knows the caller',
      'intents.yaml:19:14  intents.hours.passage  intent "hours" says the passage "card-renewal-adult", whose topic "card_renewal" has a passage for some callers only ("card-renewal-junior": card junior); an informational intent\'s answer is for every caller, read with no gate  ->  take the applies out of kb/passages/card-renewal-junior.yaml, or answer "card_renewal" through a form that answers from the knowledge base (forms.yaml answers:), whose gated read knows the caller',
    ]);
  });

  it('an intent\'s passage that is not fresh', async () => {
    const found = await lines('kb-c4', { 'kb/passages/opening-hours.yaml': (t) => t.replace('closed on Sunday', 'closed on Sundays') });
    expect(found).toEqual([
      'intents.yaml:19:14  intents.hours.passage  intent "hours" says the passage "opening-hours", which was edited after approval, so the caller hears that there is no answer and is offered a person  ->  review kb/passages/opening-hours.yaml (pnpm kb:status shows what changed), then pnpm kb:approve opening-hours --by "<your name>"',
      'kb/passages/opening-hours.yaml:13:9  approval.hash  passage "opening-hours" was edited after approval (its answer, id, locale, version, applies, dates, topic, its topic\'s title or account line), so it is withheld  ->  review the edit (pnpm kb:status shows what changed), then pnpm kb:approve opening-hours --by "<your name>"',
    ]);
  });

  it('a form\'s topic slot it does not have, an action with no row in policy.yaml, and a calls list that leaves the reads out', async () => {
    expect(await lines('kb-c5', { 'forms.yaml': (t) => APP_EDITS['forms.yaml']!(t).replace('answers: { slot: libraryTopic }', 'answers: { slot: book, via: lookUp }') })).toEqual([
      'forms.yaml:18:22  forms.ask_library.answers.slot  form "ask_library" answers the topic in the slot "book", which is not one of its slots  ->  add "book" to forms.ask_library.slots (a topic slot in slots.yaml)',
      'forms.yaml:18:33  forms.ask_library.answers.via  form "ask_library" reads its answer through "lookUp", which has no action in policy.yaml: every read the knowledge base makes goes through the gate  ->  add "lookUp:" under actions in policy.yaml, with its level and rules',
      'forms.yaml:18:33  forms.ask_library.answers.via  form "ask_library" reads its answer through "lookUp", which is not a tool in the code  ->  add it to app.ts (code.tools.lookUp) (kbAnswerTool() resolves a passage of kb/)',
    ]);
  });

  it('a calls list that leaves out the action the answer is read through, or an account line\'s tool', async () => {
    const found = await lines('kb-c8', { 'forms.yaml': (t) => APP_EDITS['forms.yaml']!(t).replace('    answers: { slot: libraryTopic }', '    answers: { slot: libraryTopic }\n    calls: []') });
    expect(found.filter((l) => l.includes('leave out'))).toEqual([
      'forms.yaml:19:5  forms.ask_library.calls  form "ask_library" answers from the knowledge base, and its calls leave out "findPassage", the action it reads its answer through  ->  add "findPassage" to forms.ask_library.calls',
      'forms.yaml:19:5  forms.ask_library.calls  form "ask_library" answers from the knowledge base, and its calls leave out "getFees", an account line\'s tool (kb/topics.yaml)  ->  add "getFees" to forms.ask_library.calls',
    ]);
  });

  it('the answer line without {answer}, the unavailable line with a variable, the lines missing in a language, and answer not a data variable', async () => {
    const found = await lines('kb-c6', {
      'prompts.yaml': (t) => APP_EDITS['prompts.yaml']!(t).replace("text: '{answer}'", 'text: Here it is.').replace("I'm sorry, I don't have an answer to that I can give you right now.", 'Sorry {first}.'),
      'locale/es/prompts.yaml': (t) => t,
      'app.yaml': (t) => t,
    });
    expect(found.filter((l) => l.includes('kb_') || l.includes('dataVars'))).toEqual([
      'app.yaml:29:1  prompts  the app says answers from the knowledge base in {answer}, which is not one of prompts.dataVars, so a line that says one could be split into recorded clips  ->  add "answer" to prompts.dataVars in app.yaml',
      expect.stringContaining('the line "kb_answer" says an answer from the knowledge base, and its text has no {answer}, so the answer is never said'),
      expect.stringContaining('the line "kb_unavailable" is said when there is no answer from the knowledge base, and uses {first}, which nothing gives it, so saying it would fail'),
      expect.stringMatching(/prompt "kb_answer" is missing from the es prompts/),
      expect.stringMatching(/prompt "kb_unavailable" is missing from the es prompts/),
    ]);
  });

  it('a form that answers and has a complete hook too', async () => {
    expect(await lines('kb-c7', { 'forms.yaml': (t) => APP_EDITS['forms.yaml']!(t).replace('answers: { slot: libraryTopic }', 'answers: { slot: libraryTopic }\n    hooks: [complete]') })).toEqual([
      expect.stringContaining('this form answers from the knowledge base, so its completion is the engine\'s, and it has a "complete" hook too  ->  delete "complete" from hooks'),
    ]);
  });
});

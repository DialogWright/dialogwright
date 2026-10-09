import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { defineApp } from './defineApp';
import { validateApp } from '../core/app/validate';
import { nextCycles } from '../core/app/next';
import { danglingReferences } from '../testing/appMap';
import { consoleMetaOf } from '../server/dashboard/meta';
import { SCREENED_DIR, screenedApp, screenedCode } from '../testing/screened/app';
import { NEXT, over, replace } from '../testing/screened/variant';

/**
 * What `check` says of a form's `next`, an internal form and `listenBeforeEntered` (design
 * 2026-10-08-sub-forms-and-listening): the refusals, which defineApp makes too, and the warning, on
 * the two-form variant of the screened fixture (a screen that goes on to an internal booking).
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the fixture's YAML as the two-form variant, each file then changed by its function. */
function folder(files: Record<string, (text: string) => string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-next-'));
  scratch.push(dir);
  cpSync(SCREENED_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  for (const [file, change] of Object.entries(over(NEXT, files))) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
  return dir;
}

async function checked(dir: string): Promise<{ problems: string[]; warnings: string[] }> {
  const r = await checkAppFully(dir, { code: screenedCode, fixturesRoot: PACKAGE_DIR });
  return { problems: r.problems.map(formatProblem), warnings: (r.warnings ?? []).map(formatProblem) };
}

describe('the two-form variant', () => {
  it('passes check with no problem and no warning', async () => {
    expect(await checked(folder())).toEqual({ problems: [], warnings: [] });
  });

  it('builds: the screen goes on to the booking, which is internal, labelled, and completes in code; the screen completes as said', () => {
    const app = defineApp(folder(), screenedCode);
    expect(app.forms.screen_home).toMatchObject({ next: 'book_visit' });
    expect(app.forms.screen_home).not.toHaveProperty('internal');
    expect(app.forms.book_visit).toMatchObject({ internal: true, label: 'book your visit' });
    expect(app.forms.book_visit).not.toHaveProperty('next');
    expect(app.forms.screen_home!.complete({ acks: [{ promptId: 'visit_qualifies', vars: {} }] } as never)).toEqual({ kind: 'said', acks: [{ promptId: 'visit_qualifies', vars: {} }] });
    expect(Object.keys(app.intents)).not.toContain('book_visit');
    // The booking is no intent, and the app map says nothing is dangling for it.
    expect(danglingReferences(app)).toEqual([]);
  });

  it('the console names the internal form by its own label, under the app\'s', () => {
    const app = defineApp(folder({ 'app.yaml': replace('    book_visit: Book a visit\n', '') }), screenedCode);
    expect(consoleMetaOf(app).formLabels).toEqual({ book_visit: 'book your visit', urgent: 'Something urgent' });
    expect(consoleMetaOf(defineApp(folder(), screenedCode)).formLabels).toEqual({ book_visit: 'Book a visit', urgent: 'Something urgent' });
    expect(consoleMetaOf(screenedApp).formLabels).toEqual({ book_visit: 'Book a visit', urgent: 'Something urgent' });
  });

  it('leaves the fixture as it was: no form of it has next, internal, label or listenBeforeEntered', () => {
    for (const form of Object.values(screenedApp.forms)) for (const key of ['next', 'internal', 'label', 'listenBeforeEntered']) expect(form).not.toHaveProperty(key);
  });
});

describe('the refusals', () => {
  it('a next to a form there is not', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('next: book_visit', 'next: book_visti') }));
    expect(problems).toContain('forms.yaml:17:11  forms.screen_home.next  form "screen_home" goes on to "book_visti", which is not a form in forms.yaml  ->  rename it to "book_visit", or add "book_visti:" under forms in forms.yaml, or delete "next"');
  });

  it('a loop of next', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('    label: book your visit\n', '    label: book your visit\n    next: screen_home\n') }));
    expect(problems).toContain('forms.yaml:17:11  forms.screen_home.next  the forms "screen_home", "book_visit" go on to each other in a loop (screen_home -> book_visit -> screen_home), so the chain never ends  ->  delete "next" from one of them: the last form of a chain completes in code (hooks: [complete])');
  });

  it('an internal form no next reaches', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': (t) => `${t}  spare:\n    internal: true\n    label: look at something else\n    slots: [visitDay]\n    summaryPromptId: null\n    calls: []\n    next: book_visit\n` }));
    expect(problems).toContain('forms.yaml:40:15  forms.spare.internal  form "spare" is internal, and no form goes on to it, so nothing can reach it  ->  add "next: spare" to the form that comes before it, or delete "internal: true" and give it an intent in intents.yaml');
  });

  it('an internal form with an intent', async () => {
    const intent = '  book_visit:\n    criteria: Books the visit\n    label: book your visit\n    kind: form\n';
    const { problems } = await checked(folder({ 'intents.yaml': replace('  urgent:\n', `${intent}  urgent:\n`) }));
    expect(problems).toContain('forms.yaml:19:15  forms.book_visit.internal  form "book_visit" is internal, so it is no intent, but intents.yaml has an intent "book_visit"  ->  delete "book_visit:" from intents.yaml (the form is reached by another form\'s next), or delete "internal: true" to make the form an intent');
  });

  it('an internal form with no label', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('    label: book your visit\n', '') }));
    expect(problems).toContain('forms.yaml:19:15  forms.book_visit.internal  an internal form has no intent, so its label is its own, and this form names none  ->  add "label: <what the caller is helped to do>" (for example "label: book your free inspection"), said as bridge_next\'s {intentLabel}');
  });

  it('a label on a form that is an intent', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('    next: book_visit\n', '    next: book_visit\n    label: check the home\n') }));
    expect(problems).toContain('forms.yaml:18:12  forms.screen_home.label  only an internal form has a label of its own: a form intent\'s label is in intents.yaml  ->  delete "label", or write "internal: true" for a form reached only by another form\'s next');
  });

  it('a form with neither a complete hook, answers, nor next', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': replace('    next: book_visit\n', '') }));
    expect(problems).toContain('forms.yaml:3:3  forms.screen_home  every form needs a "complete" hook: it says what the form does once its slots are full  ->  add "hooks: [complete]" and write the function in the app\'s code, or "answers:" for a form that says an answer from the knowledge base');
  });

  it('takes a next to a form that is also an intent: the app decides how a form is reached', async () => {
    const { problems } = await checked(folder({ 'forms.yaml': (t) => replace('  book_visit:\n    internal: true\n    label: book your visit\n', '  book_visit:\n')(t), 'intents.yaml': replace('  urgent:\n', '  book_visit:\n    criteria: Wants to book a visit\n    label: book a visit\n    kind: form\n  urgent:\n') }));
    expect(problems).toEqual([]);
  });
});

describe('validateApp, for an app written in TypeScript', () => {
  const app = defineApp(folder(), screenedCode);
  const forms = app.forms;
  const fails = (changed: Partial<typeof app>): (() => void) => () => validateApp({ ...app, ...changed });

  it('refuses each in its own words', () => {
    const { next: _next, ...stopping } = forms.screen_home!;
    expect(fails({ forms: { ...forms, screen_home: stopping } })).toThrow('app "screened-next": internal form "book_visit" is reached by no form\'s next');
    expect(fails({ forms: { ...forms, book_visit: { ...forms.book_visit!, next: 'nowhere' } } })).toThrow('app "screened-next": form "book_visit" goes on to the unknown form "nowhere"');
    expect(fails({ forms: { ...forms, book_visit: { ...forms.book_visit!, next: 'screen_home' } } })).toThrow('app "screened-next": the forms\' next go round in a loop: screen_home -> book_visit -> screen_home');
    const { label: _label, ...unlabelled } = forms.book_visit!;
    expect(fails({ forms: { ...forms, book_visit: unlabelled } })).toThrow('app "screened-next": internal form "book_visit" has no label');
    expect(fails({ intents: { ...app.intents, book_visit: { criteria: 'Books', label: 'book', kind: 'form' } } })).toThrow('app "screened-next": form "book_visit" is internal, but there is an intent "book_visit": an internal form is no intent');
    expect(fails({})).not.toThrow();
  });

  it('finds each loop once, from the form defined first', () => {
    expect(nextCycles({ a: { next: 'b' }, b: { next: 'c' }, c: { next: 'b' }, d: { next: 'a' }, e: {} })).toEqual([['b', 'c']]);
    expect(nextCycles({ a: { next: 'a' } })).toEqual([['a']]);
    expect(nextCycles({ a: { next: 'missing' } })).toEqual([]);
  });
});

describe('the warning: a slot whose listen says otherwise than every form that lists it', () => {
  it('a slot only the internal booking lists, with listen: anywhere', async () => {
    const { problems, warnings } = await checked(folder({ 'slots.yaml': replace('visitDay:\n  type: choice\n', 'visitDay:\n  type: choice\n  listen: anywhere\n') }));
    expect(problems).toEqual([]);
    expect(warnings).toEqual(['slots.yaml:55:11  visitDay.listen  the slot "visitDay" says listen: anywhere, but the form that lists it ("book_visit") says its slots do not listen before it is open (listenBeforeEntered: false, the default for an internal form); the slot\'s own listen wins  ->  nothing to do if that is meant; otherwise delete the slot\'s "listen", so it is asked once its form is open']);
  });

  it('a slot of the screen and the booking, with listen: up-front, once the screen says false too', async () => {
    const { warnings } = await checked(folder({
      'forms.yaml': replace('    next: book_visit\n', '    next: book_visit\n    listenBeforeEntered: false\n'),
      'slots.yaml': replace('town:\n  type: choice\n', 'town:\n  type: choice\n  listen: up-front\n'),
    }));
    expect(warnings).toEqual(['slots.yaml:29:11  town.listen  the slot "town" says listen: up-front, but every form that lists it ("screen_home", "book_visit") says its slots do not listen before it is open (listenBeforeEntered: false, the default for an internal form); the slot\'s own listen wins  ->  nothing to do if that is meant; otherwise delete the slot\'s "listen", so it is asked once its form is open']);
  });

  it('none for a slot the screen lists, which listens up front', async () => {
    const { warnings } = await checked(folder({ 'slots.yaml': replace('town:\n  type: choice\n', 'town:\n  type: choice\n  listen: anywhere\n') }));
    expect(warnings).toEqual([]);
  });
});

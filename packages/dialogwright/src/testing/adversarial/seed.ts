import type { FormId, SlotId } from '../../core/app/types';
import { appOf } from '../../core/app/registry';
import { formOf, identityOf } from '../../core/app/lookup';
import { appTurnContext } from '../../core/turn';
import { ensureEntry, newTurnOut } from '../../core/lifecycle';
import { emptySlot, setForm, type Session } from '../../core/session';
import { demoTools } from '../../core/tools';
import { spokenText, promptText } from '../../prompts/render';
import { seedCorpusSession, type SeedOptions } from '../../harness-text/runner';
import type { CorpusEntry } from '../../jev/corpus';
import type { Party } from '../../gate/types';
import type { CodePrompt } from './types';

type Seed = (session: Session, opts: SeedOptions) => Session;

/** The delegate `id` names, as the app's principals make them (App.principals.delegatePrincipal); throws for one that is not. */
function delegateOf(session: Session, id: string): Party {
  const p = appOf(session).principals?.delegatePrincipal?.(id) ?? null;
  if (p === null) throw new Error(`"${id}" is not a delegate the app's principals know`);
  return p;
}

/** A placeholder slot value from the app's seed (App.testing.seed.placeholders). */
function fill(session: Session, id: SlotId, confirmed: boolean): void {
  const seed = appOf(session).testing?.seed;
  const placeholder = seed && Object.hasOwn(seed.placeholders, id) ? seed.placeholders[id] : undefined;
  if (!placeholder) throw new Error(`no placeholder value for slot "${id}"`);
  session.slots[id] = { ...emptySlot(), value: placeholder.value, display: placeholder.display, confirmed };
}

/**
 * The code prompt of `form` (a form that needs level 2), as a call reaches it: the app's seed caller
 * (App.testing.seed.caller) verified to level 1 by its factors, which stay on the call, then the form's
 * entry call through the gate, whose step-up texts the code (the code tool's sending call, through
 * the gate) and asks for it. Throws when the form does not reach the code prompt this way. With
 * `delegate`, a party acting for subjects is then the one at the prompt, as if they had got there.
 */
export function codeSeed(form: FormId, delegate?: string): Seed {
  return (session, opts) => {
    const app = appOf(session);
    const seed = app.testing?.seed;
    if (!seed) throw new Error(`app "${app.id}" seeds no mid-call state (App.testing.seed)`);
    const caller = seed.caller();
    if (caller.level === 0) throw new Error(`the seed caller of app "${app.id}" is not a proven party`);
    session.principal = { ...caller, level: 1 };
    for (const id of identityOf(app).factorSlots) fill(session, id, true);
    setForm(session, form);
    session.entered = null;
    const tc = appTurnContext(app, { nowMs: 0, todayIso: opts.todayIso, thresholds: opts.thresholds, tools: opts.tools ?? demoTools() });
    const asked = ensureEntry(session, tc, newTurnOut(), []);
    if (asked?.kind !== 'prompt' || asked.target !== 'otp') throw new Error(`form ${form} does not ask for the code of a caller verified to level 1`);
    session.promptedFor = asked.target;
    session.lastPromptId = asked.promptId;
    session.lastPromptText = spokenText(app, asked, session.locale);
    session.lastPromptOptions = [];
    if (delegate !== undefined) session.principal = delegateOf(session, delegate);
    return session;
  };
}

/**
 * A form's summary read to a party acting for subjects (`delegate`), as if the form had let them
 * through: the summary as a corpus line at `confirm_<form>` is seeded (the seed's caller, the form's
 * entry call and its facts, every slot a placeholder, the summary read), then the delegate is the caller
 * who answers it. What the write then sends is the gate's to decide, for them.
 */
export function summarySeed(form: FormId, delegate: string): Seed {
  return (session, opts) => {
    const entry = { id: session.sessionId, text: '', intent: 'none', context: `confirm_${form}` } as CorpusEntry;
    const seated = seedCorpusSession(session, entry, opts);
    seated.principal = delegateOf(seated, delegate);
    return seated;
  };
}

/**
 * A form's slot asked of a party acting for subjects (`delegate`): the delegate in the form, entered
 * as the engine enters it for them (its principalEntry, else its entry call, through the gate), the
 * slots before this one placeholders, this one asked. Throws when the form does not let them in (its
 * entry refuses them or hands them to a person): then there is no slot to answer.
 */
export function slotSeed(form: FormId, slot: SlotId, delegate: string): Seed {
  return (session, opts) => {
    const app = appOf(session);
    session.principal = delegateOf(session, delegate);
    setForm(session, form);
    session.entered = null;
    for (const id of formOf(app, form).slots) {
      if (id === slot) break;
      fill(session, id, true);
    }
    const tc = appTurnContext(app, { nowMs: 0, todayIso: opts.todayIso, thresholds: opts.thresholds, tools: opts.tools ?? demoTools() });
    const instead = ensureEntry(session, tc, newTurnOut(), []);
    if (instead !== null) throw new Error(`form ${form} does not let the delegate "${delegate}" in, so there is no ${slot} to answer`);
    session.promptedFor = slot;
    session.lastPromptId = `ask_${slot}`;
    session.lastPromptText = promptText(app, `ask_${slot}`, {}, session.locale);
    session.lastPromptOptions = [];
    return session;
  };
}

/** The seed a case's seat names (CodePrompt), with its delegate where it has one; undefined for the line's own context. */
export function seatSeed(at: CodePrompt | undefined, delegate: string | undefined): Seed | undefined {
  if (at === undefined) return undefined;
  if ('code' in at) return codeSeed(at.code, delegate);
  if ('summary' in at) {
    if (delegate === undefined) throw new Error('a summary seat is a delegate\'s');
    return summarySeed(at.summary, delegate);
  }
  if (delegate === undefined) throw new Error('a slot seat is a delegate\'s');
  return slotSeed(at.form, at.slot, delegate);
}

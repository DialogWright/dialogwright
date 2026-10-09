import type { FormId } from '../../core/app/types';
import { appOf } from '../../core/app/registry';
import { identityOf } from '../../core/app/lookup';
import { appTurnContext } from '../../core/turn';
import { ensureEntry, newTurnOut } from '../../core/lifecycle';
import { emptySlot, setForm, type Session } from '../../core/session';
import { demoTools } from '../../core/tools';
import { spokenText } from '../../prompts/render';
import type { SeedOptions } from '../../harness-text/runner';

/**
 * The code prompt of `form` (a form that needs level 2), as a call reaches it: the app's seed caller
 * (App.testing.seed.caller) verified to level 1 by its factors, which stay on the call, then the form's
 * entry call through the gate, whose step-up texts the code (the code tool's sending call, through
 * the gate) and asks for it. Throws when the form does not reach the code prompt this way.
 */
export function codeSeed(form: FormId): (session: Session, opts: SeedOptions) => Session {
  return (session, opts) => {
    const app = appOf(session);
    const seed = app.testing?.seed;
    if (!seed) throw new Error(`app "${app.id}" seeds no mid-call state (App.testing.seed)`);
    const caller = seed.caller();
    if (caller.level === 0) throw new Error(`the seed caller of app "${app.id}" is not a proven party`);
    session.principal = { ...caller, level: 1 };
    for (const id of identityOf(app).factorSlots) {
      const placeholder = Object.hasOwn(seed.placeholders, id) ? seed.placeholders[id] : undefined;
      if (!placeholder) throw new Error(`no placeholder value for slot "${id}"`);
      session.slots[id] = { ...emptySlot(), value: placeholder.value, display: placeholder.display, confirmed: true };
    }
    setForm(session, form);
    session.entered = null;
    const tc = appTurnContext(app, { nowMs: 0, todayIso: opts.todayIso, thresholds: opts.thresholds, tools: opts.tools ?? demoTools() });
    const asked = ensureEntry(session, tc, newTurnOut(), []);
    if (asked?.kind !== 'prompt' || asked.target !== 'otp') throw new Error(`form ${form} does not ask for the code of a caller verified to level 1`);
    session.promptedFor = asked.target;
    session.lastPromptId = asked.promptId;
    session.lastPromptText = spokenText(app, asked, session.locale);
    session.lastPromptOptions = [];
    return session;
  };
}

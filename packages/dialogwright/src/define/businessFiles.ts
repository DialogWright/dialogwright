import { buildSlot } from '../slots/defineSlot';
import { ACCOUNT_SLOT, businessForms, fullLinesOf, closingsOf, greetingsOf, optionKey, readsThroughHook, slotIdOf, stepTool, thenTools, whenOf } from './business';
export { optionKey };
import { ACCOUNTS_ONLY_PROMPT, AGENT_ACCOUNTS_ONLY_LINE, AGENT_CLOSING_LINES, AGENT_DEFAULT_LINES, AGENT_HANDOFF_LINES, AGENT_NOT_RECOGNIZED_LINE, AGENT_OFFER_LINE } from './businessLines';
import { NOT_RECOGNIZED_PROMPT } from '../core/lifecycle';
import { fullNonePromptOf, fullPromptOf } from '../agent/types';
import { WINDOWS_OPTIONS, type BusinessFieldYaml, type BusinessFormName, type BusinessFormYaml, type BusinessYaml } from './schema/business';
import {
  SCHEMAS, normalizeIdentity, slotsSchema,
  type AppYaml, type FormsYaml, type IdentityFile, type IdentityYaml, type IntentsYaml, type PolicyYaml, type PromptsYaml, type SlotsYaml,
} from './schema/index';
import type { AuditMask } from '../core/app/types';

/**
 * The files an app in agent mode does not have, built from its business.yaml (the agent-mode design,
 * "The business-facts file"): intents.yaml, forms.yaml, slots.yaml, prompts.yaml, policy.yaml and
 * identity.yaml, each as its own schema reads it, so the rest of the engine (every check of a folder,
 * defineApp, the gate, the audit, the console, the policy card) sees an ordinary app. What they say,
 * from the file:
 *
 * - **Intents:** a form intent for each form (request, booking, callback), and the engine's control
 *   intents (agent, a person, which in agent mode is the callback note; repeat_prompt; done; other;
 *   none). No keypad menu.
 * - **Forms and slots:** each field a library slot of its type, `<form>_<field>`, asked by its own
 *   question (`ask_<form>_<field>`); the read-back is the form's summary line, each value said as its
 *   slot displays it; the form's write is the first tool of its `then`. An optional field may be left
 *   empty (onMaxAttempts: skip).
 * - **Policy:** each tool of a form's `then` is called with the form's values by field name (and on a
 *   form for accounts, the account), every one of them confirmed at the read-back (the confirmed rule);
 *   a request's and a callback's at level 0, a booking's at level 1 with the account held to the
 *   caller's own (scope). A tool whose result the model sees (`sees`) reads its field's value at the
 *   lowest level of the forms that ask it. Every action has its `say`, and every param its audit entry,
 *   as its field's slot records it.
 * - **Identity** (with a booking): level 1 is the caller-ID match, the number calling looked up in
 *   `accounts` at call start (BUSINESS_TOOLS.lookup) and recognized (BUSINESS_TOOLS.recognize). Caller
 *   ID is the identifier, never a factor the caller says; that it recognizes an account on its own is
 *   the business's accepted risk (the design's call 14), and the policy card says so.
 * - **Prompts:** the fixed lines (each read-back and done line, the price line, the handoff, the
 *   closing, the greeting) and each field's question, all said word for word, none generated, and the
 *   engine's own lines (./businessLines.ts) unless `lines` gives them.
 */

/** The tools the engine writes for an agent-mode app with accounts (./businessApp.ts): the call-start lookup and the recognition. */
export const BUSINESS_TOOLS = { lookup: 'lookupAccount', recognize: 'recognizeAccount' } as const;

/** The prompt each form's read-back, done line and fixed lines are said through. */
export const readBackPromptOf = (form: BusinessFormName): string => `readback_${form}`;
export const donePromptOf = (form: BusinessFormName): string => `done_${form}`;
/** The price line's prompt (business.yaml's prices.say). */
export const PRICE_PROMPT = 'price';

/** What the files built from business.yaml are, as the loader returns them. */
export interface BusinessFiles {
  app: AppYaml;
  /** A field whose slot did not build from what the field says (an engine error, or an option its type refuses), at its path in business.yaml. */
  problems: { path: (string | number)[]; message: string; fix: string }[];
  intents: IntentsYaml;
  forms: FormsYaml;
  slots: SlotsYaml;
  prompts: PromptsYaml;
  policy: PolicyYaml;
  identity: IdentityYaml | null;
}

/** The engine's words for each form, where business.yaml gives none: its label and what the decision model reads it by. */
const FORM_WORDS: Readonly<Record<BusinessFormName, { label: string; criteria: string }>> = {
  request: { label: 'send a request', criteria: 'Wants to ask for one of the services, or for a quote' },
  booking: { label: 'make a booking', criteria: 'Wants to book work in, as a regular account' },
  callback: { label: 'leave a callback note', criteria: 'Wants someone to call them back' },
};

/** A few words of a name written in code ("callbackNumber", "place_hold"): "callback number", "place hold". */
export function wordsOf(id: string): string {
  return id.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
}

/** A choice field's options, key to say: its own words, or the business's windows by name. */
export function fieldOptions(b: BusinessYaml, f: BusinessFieldYaml): Record<string, string> {
  if (f.options === WINDOWS_OPTIONS) return Object.fromEntries((b.windows ?? []).map((w) => [w.name, wordsOf(w.name)]));
  return Object.fromEntries((f.options ?? []).map((o) => [optionKey(o), o]));
}

/** The accounts as the account slot's options: each a key of its name, said by its name. */
export function accountOptions(b: BusinessYaml): Record<string, string> {
  return Object.fromEntries((b.accounts ?? []).map((a) => [optionKey(a.name), a.name]));
}

/** The noun a digits field's number is of ("callbackNumber" is a callback number). */
function digitsNoun(name: string): string {
  const words = wordsOf(name).replace(/\s*number$/, '').trim();
  return words === '' ? 'phone' : words;
}

/** The slots.yaml entry a field is: its library type and the options it implies. */
export function fieldSlotConfig(b: BusinessYaml, f: BusinessFieldYaml): Record<string, unknown> {
  const optional = f.optional === true ? { onMaxAttempts: 'skip' } : {};
  switch (f.type) {
    case 'choice':
      return { type: 'choice', options: fieldOptions(b, f), ...optional };
    case 'date':
      return { type: 'date', range: 'future', ...optional };
    case 'digits':
      return {
        type: 'digits',
        noun: digitsNoun(f.name),
        ...(f.length !== undefined ? { length: f.length } : {}),
        ...(f.offer === 'callerNumber' ? { callerNumber: { countryCode: f.countryCode ?? '1' } } : {}),
        ...(f.redact !== undefined ? { redact: f.redact } : {}),
        ...optional,
      };
    case 'text':
      // Read back as the line understood it (say: null), which a slot whose words the records keep only by their length cannot do: recorded as it is.
      return { type: 'text', what: f.about ?? wordsOf(f.name), say: null, redact: 'none', ...optional };
    default:
      return { type: f.type, ...optional };
  }
}

/** How a param is recorded, as its slot records its value (core/recording.ts): by the slot's redact, else as it is. */
function auditOf(redact: unknown): AuditMask {
  return redact === 'last4' || redact === 'mask' || redact === 'length' ? redact : 'keep';
}

/** The params every call a form makes carries: its fields by name, and on a form for accounts the account first. */
export function formParams(name: BusinessFormName, form: BusinessFormYaml): string[] {
  return [...(name === 'booking' ? [ACCOUNT_SLOT] : []), ...form.fields.map((f) => f.name)];
}

/** A line's text with each field's {placeholder} made its slot's ({day} in the booking is {booking_day}). */
function withSlotVars(text: string, name: BusinessFormName, form: BusinessFormYaml): string {
  const fields = new Set(form.fields.map((f) => f.name));
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, v: string) => (fields.has(v) ? `{${slotIdOf(name, v)}}` : whole));
}

/** The level a form's calls need: a booking is an account's, level 1; any other form is anyone's. */
export function formLevel(name: BusinessFormName): 0 | 1 {
  return name === 'booking' ? 1 : 0;
}

/**
 * The files business.yaml stands for (see above), each parsed by its own schema. `app` is app.yaml as
 * read; with a booking, it gains the call-start lookup. Throws only on a file business.yaml's own
 * checks should have refused (an engine error, which the loader reports as a problem).
 */
export function businessFiles(b: BusinessYaml, app: AppYaml): BusinessFiles {
  const forms = businessForms(b);
  const accounts = b.booking !== undefined;

  // slots.yaml: each field, then the account a caller-ID match recognizes.
  const slots: Record<string, Record<string, unknown>> = {};
  const fieldSlot = new Map<string, { redact: unknown }>();
  const problems: BusinessFiles['problems'] = [];
  for (const { name, form } of forms) {
    form.fields.forEach((f, i) => {
      const id = slotIdOf(name, f.name);
      const config = fieldSlotConfig(b, f);
      slots[id] = config;
      const built = buildSlot(id, config);
      if (built.ok) fieldSlot.set(id, { redact: built.spec.redact });
      else for (const p of built.problems) problems.push({ path: [name, 'fields', i], message: `the field "${f.name}" is not a ${f.type} slot: ${p.message}`, fix: p.fix });
    });
  }
  if (accounts) slots[ACCOUNT_SLOT] = { type: 'choice', options: accountOptions(b) };

  // intents.yaml
  const intents: Record<string, Record<string, unknown>> = {};
  for (const { name, form } of forms) {
    intents[name] = { criteria: FORM_WORDS[name].criteria, label: form.label ?? FORM_WORDS[name].label, kind: 'form' };
  }
  Object.assign(intents, {
    agent: { criteria: 'Asks to speak with a person, the owner, or someone who works there', label: 'speak with someone', kind: 'control' },
    repeat_prompt: { criteria: 'Asks the line to repeat what it just said', label: 'hear that again', kind: 'control' },
    done: { criteria: "Says they are finished and need nothing more, as in no thanks, that's all, or goodbye, including a bare no when just asked whether there is anything else", label: 'finish up', kind: 'control' },
    other: { criteria: 'A request this line does not handle', label: 'something else', kind: 'control' },
    none: { criteria: 'No request is expressed; the caller is only answering a question or saying something incidental', label: 'nothing', kind: 'control' },
  });

  // forms.yaml: the read-back confirms the form's write, its first tool; the tools it calls are its then and its sees.
  const formsYaml: Record<string, Record<string, unknown>> = {};
  for (const { name, form } of forms) {
    const sees = [...new Set(form.fields.flatMap((f) => (f.sees !== undefined ? [f.sees] : [])))];
    formsYaml[name] = {
      slots: form.fields.map((f) => slotIdOf(name, f.name)),
      summaryPromptId: readBackPromptOf(name),
      // A form for accounts names the account in its lines: its summary hook gives {account} the recognized account's name.
      hooks: readsThroughHook(b, name) ? ['confirmedParams', 'complete', 'onSummaryRead'] : ['confirmedParams', 'complete'],
      calls: [...thenTools(form), ...sees.filter((t) => !thenTools(form).includes(t))],
      writes: thenTools(form)[0]!,
    };
  }

  // prompts.yaml: every line word for word.
  const line = (text: string): { text: string; interruptible: boolean } => ({ text: text.trim(), interruptible: true });
  const prompts: Record<string, { text: string; interruptible: boolean }> = {};
  // The opening and closing lines of each channel: a string is the call's, and a chat has its own default.
  const greeting = greetingsOf(b);
  prompts.greeting = line(greeting.call);
  prompts.greeting_chat = line(greeting.chat);
  for (const [id, text] of Object.entries(AGENT_DEFAULT_LINES)) prompts[id] = line(text);
  for (const id of AGENT_HANDOFF_LINES) prompts[id] = line(b.handoff);
  const closing = closingsOf(b);
  prompts.goodbye = { text: closing.call.trim(), interruptible: false };
  prompts.goodbye_chat = { text: closing.chat.trim(), interruptible: false };
  for (const [id, text] of Object.entries(b.lines ?? {})) prompts[id] = { ...line(text), ...(AGENT_CLOSING_LINES.includes(id) ? { interruptible: false } : {}) };
  if (b.prices !== undefined) prompts[PRICE_PROMPT] = line(b.prices.say);
  // The account is recognized by the number calling, never asked: it has no question. A caller the
  // number does not recognize is told so where an action needs it, and offered the request.
  if (accounts) {
    prompts[NOT_RECOGNIZED_PROMPT] = line(b.lines?.[NOT_RECOGNIZED_PROMPT] ?? AGENT_NOT_RECOGNIZED_LINE);
    prompts[ACCOUNTS_ONLY_PROMPT] = line(b.lines?.[ACCOUNTS_ONLY_PROMPT] ?? (b.request !== undefined ? AGENT_ACCOUNTS_ONLY_LINE : AGENT_NOT_RECOGNIZED_LINE));
  }
  for (const { name, form } of forms) {
    for (const f of form.fields) {
      const id = slotIdOf(name, f.name);
      prompts[`ask_${id}`] = line(f.question);
      prompts[`ask_${id}_retry`] = line(f.question);
      if (f.offer === 'callerNumber') prompts[`offer_${id}`] = line(AGENT_OFFER_LINE);
      // A field held to a seen result: what is said when the option asked for is full (call 54).
      const full = fullLinesOf(form, f);
      if (full !== null) {
        prompts[fullPromptOf(id)] = line(withSlotVars(full.some, name, form));
        prompts[fullNonePromptOf(id)] = line(withSlotVars(full.none, name, form));
      }
    }
    prompts[readBackPromptOf(name)] = line(withSlotVars(form.readBack, name, form));
    prompts[donePromptOf(name)] = line(withSlotVars(form.done, name, form));
  }

  // policy.yaml
  const actions: Record<string, Record<string, unknown>> = {};
  const audit: Record<string, AuditMask> = {};
  for (const { name, form } of forms) {
    const params = formParams(name, form);
    form.then.forEach((step) => {
      const tool = stepTool(step);
      const what = b.tools?.[tool] ?? wordsOf(tool);
      // A tool held to a condition (`when`): a oneOf rule on the field's param, after the read-back's confirmation.
      const when = whenOf(step);
      actions[tool] = {
        say: what,
        level: formLevel(name),
        rules: [
          'identity', ...(name === 'booking' ? [{ scope: { param: ACCOUNT_SLOT } }] : []), { confirmed: params },
          ...(when !== undefined ? [{ oneOf: { field: when.field, values: [when.key], reason: when.reason } }] : []),
        ],
      };
    });
    for (const f of form.fields) audit[f.name] ??= auditOf(fieldSlot.get(slotIdOf(name, f.name))?.redact);
    if (name === 'booking') audit[ACCOUNT_SLOT] = 'keep';
  }
  // A tool whose result the model sees reads one field's value: at the lowest level of the forms that ask it.
  const seen = new Map<string, { field: string; level: 0 | 1 }>();
  for (const { name, form } of forms) {
    for (const f of form.fields) {
      if (f.sees === undefined) continue;
      const before = seen.get(f.sees);
      seen.set(f.sees, { field: f.name, level: before === undefined ? formLevel(name) : (Math.min(before.level, formLevel(name)) as 0 | 1) });
    }
  }
  for (const [tool, { field, level }] of seen) {
    if (actions[tool] !== undefined) continue;
    actions[tool] = { say: b.tools?.[tool] ?? `${wordsOf(tool)} for the ${wordsOf(field)}`, level, rules: ['identity'] };
  }
  if (accounts) {
    actions[BUSINESS_TOOLS.lookup] = { say: 'find the account the number calling is on file for', level: 0, rules: ['identity', { callerNumber: { field: 'callerNumber' } }] };
    actions[BUSINESS_TOOLS.recognize] = { say: 'recognize the account by the number calling', level: 0, rules: ['attempts'] };
    audit.callerNumber = 'last4';
  }

  // identity.yaml: level 1 is the caller-ID match against the accounts.
  const identity: IdentityFile | null = accounts
    ? {
        principals: { subject: ACCOUNT_SLOT },
        levels: { 1: { name: 'recognized by the number calling', factors: [ACCOUNT_SLOT], verify: BUSINESS_TOOLS.recognize, callerId: { identifies: [ACCOUNT_SLOT], ask: 'greeting' } } },
        attempts: 1,
      }
    : null;

  const appOut: AppYaml = accounts ? { ...app, callerNumber: { ...(app.callerNumber ?? {}), lookup: BUSINESS_TOOLS.lookup } } : app;
  return {
    app: appOut,
    problems,
    intents: SCHEMAS.intents.parse({ intents, menu: [] }),
    forms: SCHEMAS.forms.parse({ forms: formsYaml }),
    slots: slotsSchema.parse(slots),
    prompts: SCHEMAS.prompts.parse({ prompts }),
    policy: SCHEMAS.policy.parse({ actions, audit }),
    identity: identity === null ? null : normalizeIdentity(SCHEMAS.identity.parse(identity)),
  };
}

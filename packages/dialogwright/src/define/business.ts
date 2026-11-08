import type { AgentFacts } from '../agent/types';
import { BUILT_IN_SLOT_TYPES } from '../slots/registry';
import { unsupportedCheck } from '../slots/parts/check';
import type { SlotType, SlotTypes } from '../slots/types';
import { AGENT_LINE_IDS, engineLineVars } from './businessLines';
import { sayableParty } from '../gate/types';
import { readBusinessFile } from './load';
import { closest, formatPath, type DataPath, type Problem } from './problems';
import { BUSINESS_FORMS, WINDOWS_OPTIONS, type BusinessFieldYaml, type BusinessFormName, type BusinessFormYaml, type BusinessYaml } from './schema/business';

/**
 * business.yaml read and checked (an app in agent mode; ./schema/business.ts says what it holds), and
 * the facts the agent model is given from it (factsOf). What the file names in the app's code (the
 * tools its forms call and the tools whose results the model sees) is ./businessApp.ts's to check,
 * since only the code knows them; everything here needs the file alone.
 */

/** The file an agent-mode app's facts are read from. */
export const BUSINESS_FILE = 'business.yaml';

/** The slot the account a caller-ID match recognizes is held in, and the param a form for accounts sends it as: `{account}` in its lines. */
export const ACCOUNT_SLOT = 'account';

/** Placeholders an owner's summary may name beside the fields: what the app's own tools fill (the kind of request, who it is from, its details). */
export const OWNER_SUMMARY_VARS: readonly string[] = [ACCOUNT_SLOT, 'kind', 'who', 'details'];

/** The slot a form's field is held in: the form's name and the field's, so two forms may ask a field of one name in their own words. */
export function slotIdOf(form: BusinessFormName, field: string): string {
  return `${form}_${field}`;
}

/** An option's key: its words as an id ("not sure" is not_sure); a key that would start with a digit is prefixed. */
export function optionKey(said: string): string {
  const key = said.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key === '' ? 'option' : /^[a-z]/.test(key) ? key : `n_${key}`;
}

/** The forms business.yaml defines, in the engine's order, each with its name. */
export function businessForms(b: BusinessYaml): { name: BusinessFormName; form: BusinessFormYaml }[] {
  return BUSINESS_FORMS.flatMap((name) => (b[name] !== undefined ? [{ name, form: b[name] as BusinessFormYaml }] : []));
}

/** The {placeholders} of a line. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))];
}

/**
 * Whether a slot type takes a value from outside its own fill (agent mode, where the model understands
 * the value and the type checks it): its slots have a check (BuiltSlotSpec.check) that is not the one
 * that refuses every value (record, reference, topic). Read from the type's first example, built.
 */
export function takesAgentValues(type: SlotType): boolean {
  const memo = checkable.get(type);
  if (memo !== undefined) return memo;
  let result = false;
  try {
    const example = type.examples[0];
    if (example !== undefined) {
      const spec = type.build(example.slot, type.options.parse(example.config));
      result = typeof spec.check === 'function' && spec.check !== unsupportedCheck;
    }
  } catch {
    result = false;
  }
  checkable.set(type, result);
  return result;
}
const checkable = new WeakMap<SlotType, boolean>();

/**
 * The types refused in agent mode though they check a value: birthdate, an identity factor's type. The
 * conversation is sent to the agent model, so an app in agent mode collects no identity factor.
 */
export const AGENT_REFUSED_TYPES: readonly string[] = ['birthdate'];

/** The library's types a field may have: those that take a value from outside their fill, but the refused ones. */
export function agentFieldTypes(types: SlotTypes = BUILT_IN_SLOT_TYPES): string[] {
  return Object.values(types).filter((t) => takesAgentValues(t) && !AGENT_REFUSED_TYPES.includes(t.type)).map((t) => t.type).sort();
}

/** The redact settings each type takes from a field (its slot's `redact`); a type not listed takes none. */
const FIELD_REDACTS: Readonly<Record<string, readonly string[]>> = {
  digits: ['none', 'last4', 'length'],
  // A text value is read back as the line understood it, so the records keep it as it is.
  text: ['none'],
};

/**
 * What the file says that cannot be an app, each reported through `report` at its path in
 * business.yaml: the rules the schema cannot hold on its own. `types` are the slot types a field may
 * name (the library's by default).
 */
export function businessContentProblems(b: BusinessYaml, report: (path: DataPath, message: string, fix: string) => void, types: SlotTypes = BUILT_IN_SLOT_TYPES): void {
  const allowed = agentFieldTypes(types);
  const forms = businessForms(b);
  const allFields = new Set<string>();

  for (const { name, form } of forms) {
    const at = (rest: DataPath): DataPath => [name, ...rest];
    const seen = new Set<string>();
    form.fields.forEach((f, i) => {
      allFields.add(f.name);
      if (seen.has(f.name)) report(at(['fields', i, 'name']), `the field "${f.name}" is in the ${name} twice`, 'give each field a name of its own, or delete one');
      seen.add(f.name);
      if (name === 'booking' && f.name === ACCOUNT_SLOT) report(at(['fields', i, 'name']), `"${ACCOUNT_SLOT}" is the account the booking is for, recognized by the number calling, so a field cannot have its name`, `rename the field; the booking's lines say the account as {${ACCOUNT_SLOT}}`);
      fieldProblems(b, f, at(['fields', i]), allowed, types, report);
    });
    const names = new Set(form.fields.map((f) => f.name));
    const extras = name === 'booking' ? [ACCOUNT_SLOT] : [];
    for (const key of ['readBack', 'done'] as const) {
      for (const v of placeholdersOf(form[key])) {
        if (names.has(v) || extras.includes(v)) continue;
        const known = [...names, ...extras];
        const near = closest(v, known);
        report(at([key]), `the ${key === 'readBack' ? 'read-back' : 'done line'} names {${v}}, which is not a field of the ${name}${name === 'booking' ? ` nor {${ACCOUNT_SLOT}}` : ''}`, near ? `rename it to {${near}} if it is that field, or add a field "${v}"` : `name one of ${known.map((k) => `{${k}}`).join(', ')}, or add a field "${v}"`);
      }
    }
    // A field that may be left empty would read nothing in the read-back, unless it says what is said then
    // (says.unset); and every field is sent by the form's then, so an optional one is still named there.
    const read = placeholdersOf(form.readBack);
    form.fields.forEach((f, i) => {
      if (f.optional !== true) return;
      if (read.includes(f.name) && f.says?.unset === undefined) {
        report(at(['readBack']), `the read-back names {${f.name}}, but the field is optional, so the line would read nothing there when it is left empty`, `give the field "says: { unset: ... }", what the read-back says when it is left empty, or make the field required (delete "optional: true")`);
      }
      if (!read.includes(f.name)) {
        report(at(['fields', i, 'optional']), `the field "${f.name}" is optional, but the ${name}'s then sends it, and the read-back does not name it, so the caller would confirm a value they never heard`, `name {${f.name}} in the read-back with "says" for each option and "unset" for none, or make the field required`);
      }
    });
    // The read-back is what the caller confirms: it says every value the form's calls carry but an optional one.
    const unsaid = [...extras, ...form.fields.filter((f) => f.optional !== true).map((f) => f.name)].filter((v) => !read.includes(v));
    if (unsaid.length > 0) {
      report(at(['readBack']), `the read-back does not say ${unsaid.map((v) => `{${v}}`).join(', ')}, so the caller would confirm a value they never heard`, `add ${unsaid.map((v) => `{${v}}`).join(', ')} to the read-back, or make the field optional`);
    }
    // A value that must be free is checked against a result a field of the same form is shown (`freeFrom`).
    form.fields.forEach((f, i) => {
      if (f.freeFrom === undefined) return;
      const [tool] = f.freeFrom.split('.');
      if (f.type !== 'choice') report(at(['fields', i, 'freeFrom']), `only a choice field may be free from a seen result, and "${f.name}" is ${f.type}`, 'delete "freeFrom", or make the field a choice');
      if (!form.fields.some((o) => o.sees === tool)) {
        const seen = form.fields.flatMap((o) => (o.sees !== undefined ? [o.sees] : []));
        report(at(['fields', i, 'freeFrom']), `"${tool}" is no tool a field of the ${name} sees, so no result of it is ever shown for this form`, seen.length > 0 ? `name one of ${seen.map((t) => `"${t}"`).join(', ')}` : `give a field of the ${name} "sees: ${tool}", or delete "freeFrom"`);
      }
    });
    // A tool a form calls after the read-back is not one a field sees: the two are called with other values.
    const seenHere = new Set(form.fields.flatMap((f) => (f.sees !== undefined ? [f.sees] : [])));
    form.then.forEach((tool, i) => {
      if (seenHere.has(tool) || forms.some((o) => o.form.fields.some((f) => f.sees === tool))) report(at(['then', i]), `"${tool}" is a tool a field sees (its result shown to the model, called with that field's value), so it cannot also be one the ${name} calls after its read-back, with all its values`, `give the ${name} a tool of its own to call, or take "${tool}" out of the field's sees`);
    });
  }

  // A field of one name in two forms is one param of the calls and one audit entry: the same type and the same redact.
  const byField = new Map<string, { form: BusinessFormName; type: string; redact: string | undefined }>();
  for (const { name, form } of forms) {
    form.fields.forEach((f, i) => {
      const first = byField.get(f.name);
      if (first === undefined) byField.set(f.name, { form: name, type: f.type, redact: f.redact });
      else if (first.type !== f.type || first.redact !== f.redact) report([name, 'fields', i], `the field "${f.name}" is ${f.type}${f.redact !== undefined ? ` (redact ${f.redact})` : ''} here and ${first.type}${first.redact !== undefined ? ` (redact ${first.redact})` : ''} in the ${first.form}: a field of one name is recorded one way`, `give it the ${first.form}'s type and redact, or another name`);
    });
  }
  // A tool a field sees is called with that field's value, by its name: every field that sees it has the same name.
  const seers = new Map<string, string>();
  for (const { name, form } of forms) {
    form.fields.forEach((f, i) => {
      if (f.sees === undefined) return;
      // A seen tool is called with the field's value, and its result shown to the model: a value the
      // records hide would reach the model whole in the result (the review of Task 8).
      const redact = f.redact ?? (f.type === 'digits' ? 'last4' : 'none');
      if (redact !== 'none') report([name, 'fields', i, 'sees'], `the field "${f.name}" is recorded ${redact === 'last4' ? 'by its last four' : `by its ${redact}`} (redact ${redact}${f.redact === undefined ? ', its type\'s default' : ''}), but it sees "${f.sees}": its value, and what the tool returns for it, would be shown to the agent model whole`, `see "${f.sees}" from a field the records keep as it is (redact: none), or take sees off "${f.name}"`);
      const first = seers.get(f.sees);
      if (first === undefined) seers.set(f.sees, f.name);
      else if (first !== f.name) report([name, 'fields', i, 'sees'], `the tool "${f.sees}" is seen by the field "${first}" too, but a seen tool is called with one field's value, by its name`, `see "${f.sees}" from fields named "${first}" only, or give "${f.name}" a tool of its own`);
    });
  }

  // A form's tools carry its own values, confirmed at its read-back: one form each.
  const owner = new Map<string, BusinessFormName>();
  for (const { name, form } of forms) {
    form.then.forEach((tool, i) => {
      const first = owner.get(tool);
      if (first !== undefined) report([name, 'then', i], `the tool "${tool}" follows the ${first} too, but a tool's call carries its form's values, confirmed at that form's read-back, so it follows one form only`, `give the ${name} a tool of its own (for example "${tool}_${name}"), or take "${tool}" out of one of the two`);
      else owner.set(tool, name);
    });
  }

  // The forms the price line may be named in are forms the file has.
  (b.prices?.forms ?? []).forEach((f, i) => {
    if (!forms.some((x) => x.name === f)) report(['prices', 'forms', i], `the price line may be named in the ${f}, but the file has no ${f}`, `name ${forms.map((x) => `"${x.name}"`).join(', ')}, or add "${f}:"`);
  });

  if (b.booking !== undefined && (b.accounts ?? []).length === 0) {
    report(['booking', 'for'], 'the booking is for accounts, but the file lists no accounts, so no caller could book', 'add "accounts:", each with its name and the numbers it calls from, or delete the booking');
  }
  if (b.booking === undefined && (b.accounts ?? []).length > 0) {
    report(['accounts'], 'the file lists accounts, but has no booking, so no account is ever recognized for anything', 'add "booking:" (for: accounts), or delete the accounts');
  }
  const byNumber = new Map<string, number>();
  const byName = new Map<string, number>();
  (b.accounts ?? []).forEach((a, i) => {
    // The account's key is its name as an id: two names of one key are one account.
    const sameName = byName.get(optionKey(a.name));
    if (sameName !== undefined) report(['accounts', i, 'name'], `the account "${a.name}" is "${b.accounts![sameName]!.name}" again (both are ${optionKey(a.name)})`, 'give each account a name of its own, or merge the two');
    byName.set(optionKey(a.name), i);
    // The recognized account is named to the caller ("Thanks, {first}"): a name a line can say.
    if (!sayableParty({ kind: ACCOUNT_SLOT, level: 1, id: optionKey(a.name), first: a.name })) report(['accounts', i, 'name'], `the account name "${a.name}" is not one a line can say: letters, spaces, hyphens and apostrophes, at most four words and 40 characters`, 'shorten it, or write it without digits or symbols');
    a.numbers.forEach((n, j) => {
      const other = byNumber.get(n);
      if (other !== undefined && other !== i) report(['accounts', i, 'numbers', j], `the number ${n} is on file for "${b.accounts![other]!.name}" too, so a call from it would match neither account`, 'list the number under one account only');
      byNumber.set(n, i);
    });
  });

  const windowNames = new Set<string>();
  (b.windows ?? []).forEach((w, i) => {
    if (windowNames.has(w.name)) report(['windows', i, 'name'], `the window "${w.name}" is listed twice`, 'give each window a name of its own, or delete one');
    windowNames.add(w.name);
  });

  // Every line said in fixed words names only what it is given: the business's own lines nothing, each engine line its own.
  const fixedLines: [DataPath, string, readonly string[]][] = [
    [['handoff'], b.handoff, []],
    [['closing'], b.closing, []],
    ...(b.greeting !== undefined ? [[['greeting'], b.greeting, []] as [DataPath, string, readonly string[]]] : []),
    ...(b.prices !== undefined ? [[['prices', 'say'], b.prices.say, []] as [DataPath, string, readonly string[]]] : []),
    ...forms.flatMap(({ name, form }) => form.fields.map((f, i): [DataPath, string, readonly string[]] => [[name, 'fields', i, 'question'], f.question, []])),
  ];
  for (const [id, text] of Object.entries(b.lines ?? {})) {
    if (!AGENT_LINE_IDS.includes(id)) {
      const near = closest(id, AGENT_LINE_IDS);
      report(['lines', id], `"${id}" is not one of the engine's lines, so it is never said`, near ? `rename it to "${near}" if it is that line, or delete it` : `delete it; the lines are ${AGENT_LINE_IDS.join(', ')}`);
      continue;
    }
    fixedLines.push([['lines', id], text, engineLineVars(id)]);
  }
  for (const [path, text, vars] of fixedLines) {
    for (const v of placeholdersOf(text)) {
      if (vars.includes(v)) continue;
      report(path, `the line names {${v}}, which it is never given, so it would be said with the braces in it`, vars.length > 0 ? `name only ${vars.map((x) => `{${x}}`).join(', ')}` : 'write it without {placeholders}: it is said word for word');
    }
  }
  // The handoff is said where nothing waits for an answer (the callback form, where there is one, asks for the number).
  if (b.handoff.includes('?')) report(['handoff'], 'the handoff asks a question, but it is said where nothing waits for an answer', `make it a statement ("I'll have someone call you back.")${b.callback !== undefined ? '; the callback form asks for the number' : ', and add a callback form to collect the number'}`);

  const called = new Set(forms.flatMap(({ form }) => [...form.then, ...form.fields.flatMap((f) => (f.sees !== undefined ? [f.sees] : []))]));
  for (const tool of Object.keys(b.tools ?? {})) {
    if (!called.has(tool)) report(['tools', tool], `"${tool}" is no tool a form calls (a then) or a field sees, so its words are never read`, `${closest(tool, [...called]) ? `rename it to "${closest(tool, [...called])}" if it is that tool, or ` : ''}delete it`);
  }

  if (b.owner !== undefined) {
    for (const v of placeholdersOf(b.owner.summary)) {
      if (allFields.has(v) || OWNER_SUMMARY_VARS.includes(v)) continue;
      report(['owner', 'summary'], `the owner's summary names {${v}}, which is no field of a form and none of ${OWNER_SUMMARY_VARS.map((k) => `{${k}}`).join(', ')}`, `name a field, or one of ${OWNER_SUMMARY_VARS.map((k) => `{${k}}`).join(', ')}`);
    }
  }
}

/** One field's problems: its type, and the options only some types take. */
function fieldProblems(b: BusinessYaml, f: BusinessFieldYaml, at: DataPath, allowed: readonly string[], types: SlotTypes, report: (path: DataPath, message: string, fix: string) => void): void {
  const type = types[f.type];
  if (type === undefined) {
    const near = closest(f.type, allowed);
    report([...at, 'type'], `"${f.type}" is not a slot type of the library`, near ? `write "${near}" if it is that type; a field takes ${allowed.join(', ')}` : `write one of ${allowed.join(', ')}`);
  } else if (AGENT_REFUSED_TYPES.includes(f.type)) {
    report([...at, 'type'], `the slot type "${f.type}" is an identity factor's type, and in agent mode the conversation is sent to the agent model, so it would carry the factor`, `write one of ${allowed.join(', ')}; an app that verifies callers by a factor is a scripted app`);
  } else if (!allowed.includes(f.type)) {
    report([...at, 'type'], `the slot type "${f.type}" takes no value from outside its own fill (it has no check of a value the model understood), so in agent mode it cannot hold a field`, `write one of ${allowed.join(', ')}; a field's value is understood by the agent model and checked by its slot type`);
  }
  if (f.says !== undefined) {
    if (f.type !== 'choice') report([...at, 'says'], `only a choice field says its options in its own words, and "${f.name}" is ${f.type}`, 'delete "says"');
    else {
      const named = f.options === WINDOWS_OPTIONS ? (b.windows ?? []).map((w) => w.name) : (f.options ?? []);
      for (const key of Object.keys(f.says)) {
        if (key === 'unset') {
          if (f.optional !== true) report([...at, 'says', key], `"unset" is what is said of an optional field left empty, and "${f.name}" is required`, 'delete it, or make the field optional');
        } else if (!named.some((o) => optionKey(o) === optionKey(key))) report([...at, 'says', key], `"${key}" is not an option of "${f.name}"`, `say one of ${named.map((o) => `"${o}"`).join(', ')}, or "unset"`);
      }
    }
  }
  if (f.type === 'choice') {
    if (f.options === undefined) report(at, `the choice field "${f.name}" has no options`, `add "options: [...]", the words each option is said by${b.windows !== undefined ? `, or "options: ${WINDOWS_OPTIONS}"` : ''}`);
    else if (f.options === WINDOWS_OPTIONS && b.windows === undefined) report([...at, 'options'], `the field "${f.name}" takes the business's windows, but the file has no windows`, 'add "windows:", each with its name and what it is, or list the options');
    else if (Array.isArray(f.options)) {
      // Each option's key is its words as an id: two options of one key are one option.
      const keys = new Map<string, string>();
      f.options.forEach((o, j) => {
        const first = keys.get(optionKey(o));
        if (first !== undefined) report([...at, 'options', j], `the option "${o}" is "${first}" again (both are ${optionKey(o)})`, 'word each option differently, or delete one');
        keys.set(optionKey(o), o);
      });
    }
  } else if (f.options !== undefined) {
    report([...at, 'options'], `only a choice field has options, and "${f.name}" is ${f.type}`, `delete "options", or make the field a choice`);
  }
  if (f.type === 'digits') {
    if (f.length === undefined) report(at, `the digits field "${f.name}" does not say how many digits it has`, 'add "length:" (10 for a phone number with its area code)');
  } else {
    if (f.length !== undefined) report([...at, 'length'], `only a digits field has a length, and "${f.name}" is ${f.type}`, 'delete "length"');
    if (f.offer !== undefined) report([...at, 'offer'], `only a digits field may offer the number the caller is calling from, and "${f.name}" is ${f.type}`, 'delete "offer"');
  }
  if (f.countryCode !== undefined && f.offer === undefined) report([...at, 'countryCode'], `the field "${f.name}" has a countryCode but offers no number (offer: callerNumber)`, 'delete "countryCode", or add "offer: callerNumber"');
  if (f.redact !== undefined) {
    if (f.redact === 'length-summarized') {
      report([...at, 'redact'], `the field "${f.name}" is kept by its length only for a summary of it (length-summarized), but in agent mode the conversation is sent to the agent model, which would carry its words whole`, 'delete "redact", or write "length" to keep its words out of every record');
    } else {
      const takes = FIELD_REDACTS[f.type] ?? [];
      if (!takes.includes(f.redact)) report([...at, 'redact'], `a ${f.type} field takes ${takes.length > 0 ? `redact ${takes.join(', ')}` : 'no redact'}, not "${f.redact}"`, takes.length > 0 ? `write one of ${takes.join(', ')}, or delete it` : 'delete "redact"');
    }
  }
}

/** Whether a form's read-back is read through its summary hook: it names {account}, or a field says its options in its own words. */
export function readsThroughHook(b: BusinessYaml, name: BusinessFormName): boolean {
  const form = businessForms(b).find((f) => f.name === name)?.form;
  return name === 'booking' || (form?.fields ?? []).some((f) => f.type === 'choice' && f.says !== undefined);
}

/**
 * What the agent model may say and its background (the agent-mode design, "What the model may say"),
 * as agent/prompt.ts sends them: `says` (may_say) holds the claims, the services (with what each is),
 * what is not offered, where the business is, its days and its windows; `background` is context only;
 * `fixed` (fixed_lines) holds the lines the core says in fixed words: the price line, the handoff and
 * the closing.
 */
export function factsOf(b: BusinessYaml): AgentFacts {
  const says: string[] = [...(b.claims ?? [])];
  for (const s of b.services) says.push(s.about !== undefined ? `${s.name}: ${s.about.trim()}` : s.name);
  if ((b.notOffered ?? []).length > 0) says.push(`Not offered: ${b.notOffered!.join('; ')}.`);
  if (b.where !== undefined) {
    says.push(`Where: ${b.where.place.trim()}`);
    if (b.where.mobile !== undefined) says.push(b.where.mobile ? 'It also comes to the caller.' : 'It does not come to the caller.');
  }
  if (b.days !== undefined) says.push(`Days open: ${b.days.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(', ')}.`);
  for (const w of b.windows ?? []) says.push(`The ${w.name.replace(/_/g, ' ')} window: ${w.says.trim()}`);
  const fixed: Record<string, string> = {};
  if (b.prices !== undefined) fixed.price = b.prices.say.trim();
  fixed.handoff = b.handoff.trim();
  fixed.closing = b.closing.trim();
  return {
    name: (b.business.says ?? b.business.name).trim(),
    voice: b.business.voice.trim(),
    // The persona's own facts (business.kind, owner, oneOwner): who the line speaks for.
    ...(b.business.kind !== undefined ? { kind: b.business.kind.trim() } : {}),
    ...(b.business.owner !== undefined ? { owner: b.business.owner.trim() } : {}),
    ...(b.business.oneOwner !== undefined ? { oneOwner: b.business.oneOwner } : {}),
    says,
    background: [...(b.background ?? [])],
    fixed,
  };
}

/** What loadBusiness found: the file as read (null when there is a problem) and every problem with it. */
export interface BusinessFile {
  business: BusinessYaml | null;
  problems: Problem[];
}

/**
 * Reads an app folder's business.yaml on its own, with the loader's safe reading (./load.ts) and its
 * schema, then the rules above, each problem at its line. `types` are the slot types a field may name.
 */
export function loadBusiness(dir: string, types: SlotTypes = BUILT_IN_SLOT_TYPES): BusinessFile {
  const read = readBusinessFile(dir);
  if (read.business === null) return { business: null, problems: read.problems };
  const problems: Problem[] = [...read.problems];
  businessContentProblems(read.business, (path, message, fix) => {
    const at = read.locate(path) ?? { line: 1, column: 1 };
    problems.push({ file: BUSINESS_FILE, line: at.line, column: at.column, path: formatPath(path), message, fix });
  }, types);
  return { business: problems.length === 0 ? read.business : null, problems };
}

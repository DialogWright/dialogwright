import type { AgentFacts } from '../agent/types';
import { BUILT_IN_SLOT_TYPES } from '../slots/registry';
import { unsupportedCheck } from '../slots/parts/check';
import type { SlotType, SlotTypes } from '../slots/types';
import { AGENT_LINE_IDS } from './businessLines';
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

/** The library's types a field may have: those that take a value from outside their fill. */
export function agentFieldTypes(types: SlotTypes = BUILT_IN_SLOT_TYPES): string[] {
  return Object.values(types).filter((t) => takesAgentValues(t)).map((t) => t.type).sort();
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
    // A field that may be left empty would read nothing in the read-back (as an engine slot that may be skipped).
    for (const f of form.fields) {
      if (f.optional === true && placeholdersOf(form.readBack).includes(f.name)) {
        report(at(['readBack']), `the read-back names {${f.name}}, but the field is optional, so the line would read nothing there when it is left empty`, `take {${f.name}} out of the read-back, or make the field required (delete "optional: true")`);
      }
    }
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

  if (b.booking !== undefined && (b.accounts ?? []).length === 0) {
    report(['booking', 'for'], 'the booking is for accounts, but the file lists no accounts, so no caller could book', 'add "accounts:", each with its name and the numbers it calls from, or delete the booking');
  }
  const byNumber = new Map<string, number>();
  const byName = new Map<string, number>();
  (b.accounts ?? []).forEach((a, i) => {
    const sameName = byName.get(a.name.trim().toLowerCase());
    if (sameName !== undefined) report(['accounts', i, 'name'], `the account "${a.name}" is listed twice`, 'give each account a name of its own, or merge the two');
    byName.set(a.name.trim().toLowerCase(), i);
    a.numbers.forEach((n, j) => {
      const other = byNumber.get(n);
      if (other !== undefined && other !== i) report(['accounts', i, 'numbers', j], `the number ${n} is on file for "${b.accounts![other]!.name}" too, so a call from it would match neither account`, 'list the number under one account only');
      byNumber.set(n, i);
    });
  });

  for (const id of Object.keys(b.lines ?? {})) {
    if (AGENT_LINE_IDS.includes(id)) continue;
    const near = closest(id, AGENT_LINE_IDS);
    report(['lines', id], `"${id}" is not one of the engine's lines, so it is never said`, near ? `rename it to "${near}" if it is that line, or delete it` : `delete it; the lines are ${AGENT_LINE_IDS.join(', ')}`);
  }

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
  } else if (!allowed.includes(f.type)) {
    report([...at, 'type'], `the slot type "${f.type}" takes no value from outside its own fill (it has no check of a value the model understood), so in agent mode it cannot hold a field`, `write one of ${allowed.join(', ')}; a field's value is understood by the agent model and checked by its slot type`);
  }
  if (f.type === 'choice') {
    if (f.options === undefined) report(at, `the choice field "${f.name}" has no options`, `add "options: [...]", the words each option is said by${b.windows !== undefined ? `, or "options: ${WINDOWS_OPTIONS}"` : ''}`);
    else if (f.options === WINDOWS_OPTIONS && b.windows === undefined) report([...at, 'options'], `the field "${f.name}" takes the business's windows, but the file has no windows`, 'add "windows:", each with its name and what it is, or list the options');
  } else if (f.options !== undefined) {
    report([...at, 'options'], `only a choice field has options, and "${f.name}" is ${f.type}`, `delete "options", or make the field a choice`);
  }
  if (f.type === 'digits') {
    if (f.length === undefined) report(at, `the digits field "${f.name}" does not say how many digits it has`, 'add "length:" (10 for a phone number with its area code)');
  } else {
    if (f.length !== undefined) report([...at, 'length'], `only a digits field has a length, and "${f.name}" is ${f.type}`, 'delete "length"');
    if (f.offer !== undefined) report([...at, 'offer'], `only a digits field may offer the number the caller is calling from, and "${f.name}" is ${f.type}`, 'delete "offer"');
  }
  if (f.redact !== undefined) {
    if (f.redact === 'length-summarized') {
      report([...at, 'redact'], `the field "${f.name}" is kept by its length only for a summary of it (length-summarized), but in agent mode the conversation is sent to the agent model, which would carry its words whole`, 'delete "redact", or write "length" to keep its words out of every record');
    } else {
      const takes = FIELD_REDACTS[f.type] ?? [];
      if (!takes.includes(f.redact)) report([...at, 'redact'], `a ${f.type} field takes ${takes.length > 0 ? `redact ${takes.join(', ')}` : 'no redact'}, not "${f.redact}"`, takes.length > 0 ? `write one of ${takes.join(', ')}, or delete it` : 'delete "redact"');
    }
  }
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

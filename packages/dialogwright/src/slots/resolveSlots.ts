import type { Document, LineCounter } from 'yaml';
import type { SlotSpec } from '../core/slots/types';
import type { TopicCatalog } from '../kb/types';
import { closest, formatPath, keyPositionOf, positionOf, type DataPath, type Problem } from '../define/problems';
import { CODE_SLOT_TYPE } from '../define/schema/slots';
import { buildSlot } from './defineSlot';
import { BUILT_IN_SLOT_TYPES, registerSlotType } from './registry';
import type { SlotTypes } from './types';

/**
 * Putting an app's slots together from slots.yaml and its code.
 *
 * slots.yaml names every slot the app has, each either a library type with its options or
 * `{ type: code }` (the slot is the code's, `code.slots.<id>`). The order of its keys is the order of
 * `App.slots`, and that order matters: outside a form the engine fills slots in it, acknowledges a
 * value it heard in it, and when two slots could each take what the caller said (a number, a
 * name), the earlier one is offered it first. Writing the order down in one file, and refusing any
 * other, keeps it from depending on how a map happened to be built in code.
 *
 * Shared by defineApp (a folder's slots.yaml), `dialogwright check` and defineSlots (an app that is
 * not a folder), so the rules and their messages are the same everywhere.
 */

/** Where slots.yaml was read, so a problem points at its line; absent for slots given as an object (their problems have no line). */
export interface SlotsFileSource {
  doc: Document;
  lines: LineCounter;
}

export interface ResolveSlotsInput {
  /** slots.yaml as parsed: slot id to its configuration, in file order. */
  configs: Readonly<Record<string, Record<string, unknown>>>;
  /** The slots the code writes (`code.slots`). */
  codeSlots: Readonly<Record<string, SlotSpec>>;
  /** The slot types a library slot may name. Default: the built-in ones. */
  types?: SlotTypes;
  /** The file's name in problems. Default "slots.yaml". */
  file?: string;
  source?: SlotsFileSource;
  /** How a fix names a part of the code: `app.ts (code.slots.note)`. Default: the bare accessor. */
  inCode?: (...segs: readonly string[]) => string;
  /** The app's knowledge topics, given to every library slot's build (BuildSlotOptions.catalog). */
  catalog?: TopicCatalog;
}

export interface ResolvedSlots {
  /** Every slot that built, in slots.yaml's order. */
  slots: Record<string, SlotSpec>;
  /** The ids that came from a library type, not from code. */
  library: ReadonlySet<string>;
  /** Every id slots.yaml lists, built or not, in its order. */
  ids: readonly string[];
  problems: Problem[];
}

const has = (obj: object, key: string): boolean => Object.hasOwn(obj, key);

/**
 * The slots of an app with a slots.yaml: library slots built from their configuration, code slots
 * taken from `codeSlots`, in the file's order, and every problem: an unknown type, bad options (each
 * at its line), a code slot the file does not list, `{ type: code }` for a slot the code lacks, and a
 * slot that is both a library slot and in the code.
 */
export function resolveSlots(input: ResolveSlotsInput): ResolvedSlots {
  const { configs, codeSlots, source } = input;
  const types = input.types ?? BUILT_IN_SLOT_TYPES;
  const file = input.file ?? 'slots.yaml';
  const inCode = input.inCode ?? ((...segs: readonly string[]) => `code${segs.map((s) => `.${s}`).join('')}`);
  const problems: Problem[] = [];
  const problem = (path: DataPath, message: string, fix: string, onKey = false): void => {
    const at = source ? (onKey ? keyPositionOf(source.doc, source.lines, path) : positionOf(source.doc, source.lines, path)) : { line: 0, column: 0 };
    problems.push({ file, ...at, path: formatPath(path), message, fix });
  };

  const typeNames = Object.keys(types);
  const known = [...typeNames, CODE_SLOT_TYPE];
  const oneOf = known.map((n) => `"${n}"`).join(', ');
  const ids = Object.keys(configs);
  const slots: Record<string, SlotSpec> = {};
  const library = new Set<string>();

  for (const id of ids) {
    const config = configs[id]!;
    const type = config.type;
    if (type === CODE_SLOT_TYPE) {
      for (const key of Object.keys(config)) {
        if (key !== 'type') problem([id, key], `the slot "${id}" is { type: code }, which takes no options, but has "${key}"`, `delete "${key}" (the code's slot has its own settings in ${inCode('slots', id)}), or give the slot a library type`, true);
      }
      if (!has(codeSlots, id)) {
        const unlisted = Object.keys(codeSlots).filter((slot) => !has(configs, slot));
        const guess = closest(id, unlisted);
        problem(
          [id],
          `${file} says the slot "${id}" is written in code ({ type: code }), but the code defines no slot "${id}"`,
          `${guess ? `rename it to "${guess}", or ` : ''}add the slot to ${inCode('slots', id)}, or give it a library type here (one of ${typeNames.map((n) => `"${n}"`).join(', ')})`,
        );
      } else {
        slots[id] = codeSlots[id]!;
      }
      continue;
    }
    if (typeof type !== 'string' || !has(types, type)) {
      const guess = typeof type === 'string' ? closest(type, known) : undefined;
      problem(
        [id, 'type'],
        `the slot "${id}" has the type ${JSON.stringify(type)}, which is not a slot type here; the types are ${oneOf}`,
        guess ? `change it to "${guess}"` : `use one of ${oneOf}, or register the type (registerSlotType) and pass it in the code's slotTypes`,
      );
      continue;
    }
    if (has(codeSlots, id)) {
      problem(
        [id],
        `the slot "${id}" is a "${type}" slot in ${file} and the code defines it too (${inCode('slots', id)}), so it would be built twice`,
        `delete it from ${inCode('slots', id)}, or change ${file} to "${id}: { type: code }" to keep the code's slot`,
        true,
      );
    }
    const built = buildSlot(id, config, {
      types, file, ...(source ? { source: { file, doc: source.doc, lines: source.lines, at: [id] } } : {}), ...(input.catalog !== undefined ? { catalog: input.catalog } : {}),
    });
    if (built.ok) {
      slots[id] = built.spec;
      library.add(id);
    } else {
      problems.push(...built.problems);
    }
  }

  for (const id of Object.keys(codeSlots)) {
    if (has(configs, id)) continue;
    problem(
      [],
      `the code defines the slot "${id}" (${inCode('slots', id)}), but ${file} does not list it; when an app has a ${file}, it lists every slot the app has, in the order they are filled`,
      `add "${id}: { type: code }" to ${file}, where the slot belongs in the order, or delete the slot from ${inCode('slots', id)}`,
    );
  }
  return { slots, library, ids, problems };
}

/** A problem with the types an app registers: where in the code (`code.slotTypes.note`), what is wrong, and the fix. */
export interface SlotTypeProblem {
  path: string;
  message: string;
  fix: string;
}

/**
 * The types an app's code may name in slots.yaml: the built-in ones, plus the app's own. Each of the
 * app's types is added with registerSlotType, so a name already taken (a built-in's, above all) is
 * refused rather than shadowing it; a map that is itself the result of registerSlotType (it holds the
 * built-in types too) is accepted, and its built-in entries are not counted as the app's.
 * `inCode` names a part of the code for a fix (`src/app.ts (code.slotTypes)`).
 */
export function mergeSlotTypes(own: SlotTypes | undefined, inCode: (...segs: readonly string[]) => string): { types: SlotTypes; problems: SlotTypeProblem[] } {
  let types = BUILT_IN_SLOT_TYPES;
  const problems: SlotTypeProblem[] = [];
  const where = inCode('slotTypes');
  for (const [key, type] of Object.entries(own ?? {})) {
    if (typeof type?.type === 'string' && BUILT_IN_SLOT_TYPES[type.type] === type) continue;
    const path = `code.slotTypes${/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`}`;
    if (typeof type?.type !== 'string' || typeof type.build !== 'function') {
      problems.push({ path, message: `${path} is not a slot type`, fix: 'build it with defineSlotType({ type, options, build, examples })' });
    } else if (type.type === CODE_SLOT_TYPE) {
      problems.push({ path, message: `the slot type name "${CODE_SLOT_TYPE}" is reserved: { type: code } in slots.yaml means the code writes the slot`, fix: `give the type another name in ${where}` });
    } else if (has(BUILT_IN_SLOT_TYPES, type.type)) {
      problems.push({ path, message: `the slot type "${type.type}" is a built-in type, and an app's own type may not take its name`, fix: `give the type another name (for example "my-${type.type}") in ${where}` });
    } else if (has(types, type.type)) {
      problems.push({ path, message: `the slot type "${type.type}" is registered twice in ${where}`, fix: 'register each type once, under its own name' });
    } else {
      types = registerSlotType(type, types);
    }
  }
  return { types, problems };
}

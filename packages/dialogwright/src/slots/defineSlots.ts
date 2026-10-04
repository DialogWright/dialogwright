import { Document, LineCounter } from 'yaml';
import type { SlotSpec } from '../core/slots/types';
import { AppDefinitionError } from '../define/defineApp';
import { loadSlotsFile } from '../define/load';
import { problemsOfIssues, type Problem } from '../define/problems';
import { slotsSchema, SLOTS_FILE } from '../define/schema/slots';
import { resolveSlots, type SlotsFileSource } from './resolveSlots';
import { BUILT_IN_SLOT_TYPES } from './registry';
import { topicCatalog } from '../kb/catalog';
import type { AppKnowledge } from '../kb/types';
import type { SlotTypes } from './types';

/** What defineSlots builds the slots with beyond their configuration. */
export interface DefineSlotsOptions {
  /** The app's knowledge (App.knowledge): a `topic` slot is built with its topics. */
  knowledge?: AppKnowledge;
}

/**
 * The slots of an app that is not a folder (so there is no `defineApp` to read a slots.yaml): the
 * same rules, the same messages. `source` is the path of a slots.yaml (its problems point at its
 * lines) or the slots as an object already parsed (a map of slot id to `{ type, ...options }`; its
 * problems name paths but have no line). `codeSlots` are the slots the code writes: each must be
 * listed as `{ type: code }`, and none may also be a library slot. `types` adds the app's own slot
 * types to the built-in ones (`registerSlotType`). `options.knowledge` is the app's knowledge
 * (App.knowledge, the same object): a `topic` slot is built with its topics (topicCatalog).
 *
 * Returns the slots by id in the order the source lists them, which is the order the app's `slots`
 * should have (fill and acknowledgement order, and which slot is offered what the caller said when
 * two could take it). Throws an AppDefinitionError listing every problem.
 *
 *   const slots = defineSlots('src/slots.yaml', { pickupDate: pickupDateSlot });
 *   const app: App = { ..., slots };
 */
export function defineSlots(
  source: string | Record<string, unknown>,
  codeSlots: Record<string, SlotSpec>,
  types: SlotTypes = BUILT_IN_SLOT_TYPES,
  options: DefineSlotsOptions = {},
): Record<string, SlotSpec> {
  let file: string;
  let configs: Record<string, Record<string, unknown>> | null;
  let at: SlotsFileSource | undefined;
  const problems: Problem[] = [];
  if (typeof source === 'string') {
    file = source;
    const read = loadSlotsFile(source);
    problems.push(...read.problems);
    configs = read.slots;
    at = { doc: read.doc, lines: read.lines };
  } else {
    file = SLOTS_FILE;
    const parsed = slotsSchema.safeParse(source);
    configs = parsed.success ? parsed.data : null;
    if (!parsed.success) {
      const doc = new Document(source);
      problems.push(...problemsOfIssues(parsed.error.issues, { file, doc, lines: new LineCounter(), value: source, schema: { type: 'object' } }).map((p) => ({ ...p, line: 0, column: 0 })));
    }
  }
  if (configs !== null) {
    const catalog = options.knowledge !== undefined ? topicCatalog(options.knowledge) : undefined;
    const resolved = resolveSlots({
      configs, codeSlots, types, file, ...(at ? { source: at } : {}), ...(catalog !== undefined ? { catalog } : {}),
      inCode: (...segs) => `code${segs.map((s) => `.${s}`).join('')}`,
    });
    problems.push(...resolved.problems);
    if (problems.length === 0) return resolved.slots;
  }
  throw new AppDefinitionError(file, problems, `the slots in ${typeof source === 'string' ? source : 'the given object'}`);
}

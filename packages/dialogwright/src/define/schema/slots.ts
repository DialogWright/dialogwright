import { z } from 'zod';
import { SLOT_LISTEN_VALUES, type SlotListen } from '../../core/slots/types';
import { identifier } from './common';

/**
 * slots.yaml: the slots of an app, by id. Optional. A slot is either a library type with its options
 * (`note: { type: text, what: a note for the courier }`) or `{ type: code }`, a slot the app's code
 * writes (`code.slots.<id>`). When the file exists it lists every slot the app has, and its key order
 * is the order of `App.slots`.
 *
 * This is the outer shape only: a map of ids to maps that have a `type`. Each library type's own
 * options are checked by the type (slots/defineSlot.ts), because they depend on which types the app
 * has (it may register its own), and positioned in this file. The JSON Schema written to
 * schemas/slots.schema.json (./json.ts slotsJsonSchema) is the full one: every built-in type's
 * options, and `{ type: code }`.
 */

/** The file, in the app folder. */
export const SLOTS_FILE = 'slots.yaml';

/** The `type` that means the code supplies the slot. A slot type may not take this name. */
export const CODE_SLOT_TYPE = 'code';

/** The option every library slot takes beside its type's own (SlotSpec.listen). A slot type may not have an option of this name. */
export const LISTEN_OPTION = 'listen';

/** What `listen:` means, as the JSON Schema, the slot pages and an editor say it. */
export const LISTEN_DESCRIPTION =
  'Where the slot listens outside a form. "up-front": asked there, and a value kept only when the turn enters a form that has the slot (values said up front with the request). ' +
  '"form": asked and filled only while a form that has it is open; outside one its question is not sent. ' +
  '"anywhere": a value said outside a form is kept when said on a turn that opens no form, or with the request for a form that has the slot, until a form that has the slot uses it; a turn that opens a form without it keeps nothing for it. ' +
  '"call": as anywhere, and kept for the whole call, across forms (what app.yaml\'s carrySlots does). An identity factor listens as identity.yaml says, and takes none.';

/** `listen:` on one slot: one of the values, or absent for the default (`up-front`). */
export const slotListenSchema = z.enum(SLOT_LISTEN_VALUES as readonly [SlotListen, ...SlotListen[]]).describe(LISTEN_DESCRIPTION);

/** The other option every library slot takes beside its type's own (SlotSpec.offer). A slot type may not have an option of this name. */
export const OFFER_OPTION = 'offer';

/** What `offer:` means, as the JSON Schema, the slot pages and an editor say it. */
export const OFFER_DESCRIPTION =
  'Propose a value in place of the question. "facts": when the form would ask the slot and the app\'s facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling), the line asks offer_<slot> as a yes or no, with the value as {<slot>} ("Is this about 22 Alder Street?"), once per slot per form. ' +
  'A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks ask_<slot> with no attempt counted, and a value said instead fills as said. ' +
  'Needs app.yaml\'s callerNumber with a lookup, and offer_<slot> in every locale. Never on an identity factor, nor beside callerNumber.';

/** `offer:` on one slot: `facts`, or absent for none. */
export const slotOfferSchema = z.enum(['facts']).describe(OFFER_DESCRIPTION);

export const slotsSchema = z
  .record(
    identifier(),
    z
      .looseObject({
        type: z.string().describe('The slot type: a library type (text, ...), a type the app registers, or "code" for a slot the code writes (code.slots.<id>).'),
      })
      .describe('One slot: its type and that type\'s options.'),
  )
  .describe('slots.yaml: the app\'s slots by id, in the order they are filled and acknowledged. Lists every slot the app has.');

/** A parsed slots.yaml: each slot id and its `type` with the type's options beside it. */
export type SlotsYaml = z.infer<typeof slotsSchema>;

/**
 * locale/<tag>/slots.yaml: a locale's wording for the app's library slots, by slot id. Optional. Each
 * entry gives what the slot's type lets a locale say its own way (a choice option's `say`, a text
 * slot's stand-in), merged over the slot's options for sessions in that locale; never its questions.
 *
 * This is the outer shape only: a map of slot ids to maps. What each entry may hold depends on the
 * slot's type and options, so it is checked when the slots are built (slots/wording.ts).
 */
export const localeSlotsSchema = z
  .record(
    identifier(),
    z.record(z.string(), z.unknown(), { error: 'must be a map of what the slot says its own way in this locale, such as "options:" or "say:"' }).describe('One slot\'s wording in this locale.'),
  )
  .describe('locale/<tag>/slots.yaml: how the app\'s library slots say their values in this locale, by slot id.');

/** A parsed locale/<tag>/slots.yaml: each slot id and what the locale gives for it. */
export type LocaleSlotsYaml = z.infer<typeof localeSlotsSchema>;

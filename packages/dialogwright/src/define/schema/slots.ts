import { z } from 'zod';
import { OFFER_ANSWERS_VALUES, SLOT_LISTEN_VALUES, SLOT_OFFER_AT_VALUES, type OfferAnswers, type SlotListen, type SlotOfferAt } from '../../core/slots/types';
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
  '"call": as anywhere, and kept for the whole call, across forms (what app.yaml\'s carrySlots does). An identity factor listens as identity.yaml says, and takes none. ' +
  'Without it, the slot listens as its forms say (forms.yaml listenBeforeEntered): "form" when every form that lists it says false (the default for an internal form), else "up-front".';

/** `listen:` on one slot: one of the values, or absent for the default (`up-front`). */
export const slotListenSchema = z.enum(SLOT_LISTEN_VALUES as readonly [SlotListen, ...SlotListen[]]).describe(LISTEN_DESCRIPTION);

/** The other option every library slot takes beside its type's own (SlotSpec.offer). A slot type may not have an option of this name. */
export const OFFER_OPTION = 'offer';

/** What `offer:` means, as the JSON Schema, the slot pages and an editor say it. */
export const OFFER_DESCRIPTION =
  'Propose a value in place of the question. "facts": when the form would ask the slot and the app\'s facts have a value for it (code.facts.offers; e.g. the street the call-start lookup found for the number calling, or one a form\'s entry call loaded after identity), the line asks offer_<slot> as a yes or no, with the value as {<slot>} ("Is this about 22 Alder Street?"), once per slot per form. ' +
  'A yes fills the slot with it, confirmed, and nothing else: never who the caller is or their identity level. A no asks ask_<slot> with no attempt counted, and a value said instead fills as said. ' +
  'Needs code.facts.offers, and offer_<slot> in every locale. Never on an identity factor, nor beside callerNumber, nor on a slot redacted by its length (its words are never said back).';

/** `offer:` on one slot: `facts`, or absent for none. */
export const slotOfferSchema = z.enum(['facts']).describe(OFFER_DESCRIPTION);

/** The option beside `offer` every library slot takes (SlotSpec.offerAt). A slot type may not have an option of this name. */
export const OFFER_AT_OPTION = 'offerAt';

/** What `offerAt:` means, as the JSON Schema, the slot pages and an editor say it. */
export const OFFER_AT_DESCRIPTION =
  'Where a slot with offer: facts proposes. "slot" (the default): when its form would ask it. "greeting": at call start, on a call, after the call-start lookup, in place of the greeting\'s open question (greeting_offer, then offer_<slot>), when the facts have a value for it then; otherwise at the slot. One greeting proposal per call, the first such slot in slots.yaml order. ' +
  'A yes fills the slot, confirmed, kept for whichever form uses it, and greet_after_offer asks the open question; a yes with a request goes on to the request. A no, or a request with neither, leaves the slot to be asked in its form, not proposed again there. ' +
  'Needs offer: facts, and greeting_offer and greet_after_offer in every locale.';

/** `offerAt:` on one slot: `slot` or `greeting`, or absent for the default (`slot`). */
export const slotOfferAtSchema = z.enum(SLOT_OFFER_AT_VALUES as readonly [SlotOfferAt, ...SlotOfferAt[]]).describe(OFFER_AT_DESCRIPTION);

/** The option beside `offer` every library slot takes (SlotSpec.offerAnswers). A slot type may not have an option of this name. */
export const OFFER_ANSWERS_OPTION = 'offerAnswers';

/** What `offerAnswers:` means, as the JSON Schema, the slot pages and an editor say it. */
export const OFFER_ANSWERS_DESCRIPTION =
  'What a slot with offer: facts takes at its proposal. "yes-no-or-value" (the default): a yes, a no, or a value of the caller\'s own, which fills the slot as said. ' +
  '"yes-no": a yes or a no only. A value said at the proposal is not taken, and with no clear yes it is a no (the slot\'s question is then asked); on the keypad 1 is yes and 2 is no. ' +
  'Use yes-no where the line asks only a yes or no question ("Are you calling about the account ending in 1234?"). Needs offer: facts.';

/** `offerAnswers:` on one slot: `yes-no-or-value` or `yes-no`, or absent for the default (`yes-no-or-value`). */
export const slotOfferAnswersSchema = z.enum(OFFER_ANSWERS_VALUES as readonly [OfferAnswers, ...OfferAnswers[]]).describe(OFFER_ANSWERS_DESCRIPTION);

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

import type { z } from 'zod';
import type { SlotOutcome, SlotPartial, SlotPrompt, SlotSpec } from '../core/slots/types';

/**
 * The slot library's contract. A slot type turns validated options into a SlotSpec, so the engine
 * runs a library slot exactly as it runs one written by hand; the library adds a schema for the
 * options, starter examples and docs, and the conformance kit (./conformance) proves a type keeps
 * the contract.
 */

/** What a type builds: a SlotSpec that declares every question id it may ask and every line it may lead to. */
export type BuiltSlotSpec = SlotSpec & { questionIds: readonly string[]; prompts: readonly SlotPrompt[] };

/** A built-in or contributed slot type. `O` is its options as parsed (defaults applied). */
export interface SlotType<O = unknown> {
  /** Its name, as an app writes it (`type: text`): lower case letters, digits and hyphens. */
  type: string;
  /**
   * The options a slot of this type takes, without `type`. A strict zod object
   * (z.strictObject), so a misspelt option is refused rather than ignored; describe each option
   * (`.describe(...)`), since its docs page and the problems an author is shown read those words.
   */
  options: z.ZodType<O>;
  /** The slot, from its id and its parsed options. Must declare `questionIds` and `prompts`. */
  build(id: string, options: O): BuiltSlotSpec;
  /**
   * Configurations with starter utterances (a type keeps them in its examples.yaml), which the docs
   * show and the conformance kit runs. Read when first asked for, not when the type is imported.
   */
  readonly examples: readonly SlotExample[];
  /** For the type's docs page. */
  describe?: SlotTypeDocs;
}

/** What a type's docs page says about it beyond its options. */
export interface SlotTypeDocs {
  /** One sentence: what values the type collects. */
  summary: string;
  /** When to reach for it, and what it does not do. */
  notes?: string;
}

/**
 * A slot a type built (defineSlot), with the type's name and its parsed options beside the spec,
 * so app code can read them (a choice slot's option list, a text slot's stand-in).
 */
export type LibrarySlotSpec<O = unknown> = SlotSpec & {
  readonly type: string;
  readonly config: Readonly<O>;
};

/** One example configuration of a type, with what a caller might say to a slot built from it. */
export interface SlotExample {
  /** A short name, unique within the type ("courier note"). */
  name: string;
  /** What the example shows, in a sentence. */
  about?: string;
  /** The slot id the configuration is built under. */
  slot: string;
  /** The options, as an app writes them, without `type`. */
  config: Readonly<Record<string, unknown>>;
  /** Starter utterances: the words, the model's answers to the slot's questions, and the outcome expected. */
  utterances: readonly SlotUtterance[];
  /** For a type with a keypad rung: keys and the value they give, or null for keys that are no value. */
  keypad?: readonly SlotKeypadExample[];
}

/**
 * What a caller says, the answers the model gives the slot's questions (a slot reads answers, not
 * words, so an example supplies them as a stub or a recording would), and the outcome expected.
 */
export interface SlotUtterance {
  text: string;
  /** The model's answers, by question id. Absent: no answers at all. */
  answers?: Readonly<Record<string, ExampleAnswer>>;
  /** The turn around the words. Absent fields take the defaults of a fresh, unprompted turn. */
  context?: ExampleContext;
  expect: ExpectedOutcome;
}

/** An answer as an example writes it: a yes-or-no probability, or a label's (or a level's) probabilities. */
export type ExampleAnswer = { noul: number } | { choice: Readonly<Record<string, number>> } | { score: Readonly<Record<string, number>> };

/** The parts of a slot context an example may set. */
export interface ExampleContext {
  prompted?: boolean;
  current?: string | null;
  locale?: string;
  window?: SlotPartial | null;
  todayIso?: string;
  /** The app's records the slot may choose among (SlotContext.records). */
  records?: readonly unknown[];
}

/** The outcome an utterance should give: its kind, and any of its fields to compare exactly. */
export interface ExpectedOutcome {
  kind: SlotOutcome['kind'];
  value?: string;
  display?: string;
  confirm?: 'none' | 'implicit';
  reason?: string;
  /** An invalid outcome's `raw`: what was heard that cannot be the value. */
  raw?: string;
  retryPromptId?: string;
  promptId?: string;
}

export interface SlotKeypadExample {
  digits: string;
  expect: { value: string; display?: string } | null;
}

/** Slot types by name: the built-in ones, and any an app adds (registerSlotType). */
export type SlotTypes = Readonly<Record<string, SlotType<any>>>;

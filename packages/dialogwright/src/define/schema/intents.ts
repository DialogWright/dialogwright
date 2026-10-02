import { z } from 'zod';
import { REQUIRED_CONTROL_INTENTS } from '../../core/app/validate';
import { checkAlways, identifier, matching, text } from './common';

/**
 * intents.yaml: what a caller can ask for, and the keypad menu. Mirrors App.intents (IntentDef) and
 * App.menu. Intents are listed in the order the decision model is offered them.
 */

const intentDef = z
  .strictObject({
    criteria: text().describe('The criteria text sent to the decision model: when a caller\'s words mean this intent ("Wants to cancel an existing appointment"). Sent as it is, so a change re-keys a recorded cassette.'),
    label: text().describe('The spoken label ("track a parcel"), used in acknowledgements and confirmations ("I\'d be happy to help you track a parcel").'),
    kind: z
      .enum(['form', 'informational', 'control'])
      .describe('form: starts the form of the same id in forms.yaml. informational: plays its promptId and resumes. control: the engine\'s own (agent, repeat_prompt, done, other, none).'),
    promptId: identifier().optional().describe('For an informational intent, the prompt played (an id in prompts.yaml).'),
  })
  .check(checkAlways((value, ctx) => {
    const def = value as { kind?: unknown; promptId?: unknown } | null;
    if (typeof def !== 'object' || def === null) return;
    if (def.kind === 'informational' && def.promptId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'an informational intent plays a prompt, and this one names none',
        params: { fix: 'add "promptId: <id>" naming the prompt in prompts.yaml that this intent plays' },
      });
    }
  }));

const menuEntry = z
  .strictObject({
    digit: matching(/^[0-9*#]$/, 'is not a keypad digit: it must be one of 0-9, * or #', 'use a single key: 0 to 9, * or #, in quotes')
      .describe('The key the caller presses, as a quoted string ("1"; an unquoted 1 is a number in YAML).'),
    intent: identifier().describe('The intent that key chooses (an id under `intents`).'),
  })
  .describe('One key of the keypad menu.');

export const intentsSchema = z
  .strictObject({
    intents: z
      .record(identifier(), intentDef, { error: 'must be a map from intent id to its definition' })
      .check(checkAlways((intents, ctx) => {
        if (typeof intents !== 'object' || intents === null || Array.isArray(intents)) return;
        for (const required of REQUIRED_CONTROL_INTENTS) {
          if (!Object.hasOwn(intents, required)) {
            ctx.addIssue({
              code: 'custom',
              path: [],
              message: `the control intent "${required}" is missing: the engine reads it by name`,
              params: {
                fix:
                  required === 'agent'
                    ? 'add "agent:" with kind: control (the caller asks for a person), for example: criteria: Asks to speak with a person; label: speak with someone'
                    : 'add "repeat_prompt:" with kind: control (the caller asks to hear that again), for example: criteria: Asks the system to repeat what it just said; label: hear that again',
              },
            });
          }
        }
      }))
      .describe('Every intent the app hears, by id, in the order the decision model is offered them. Each form intent has a form of the same id in forms.yaml; `agent` and `repeat_prompt` are required control intents.'),
    menu: z
      .array(menuEntry)
      .check(checkAlways((entries, ctx) => {
        if (!Array.isArray(entries)) return;
        const seen = new Set<unknown>();
        entries.forEach((entry: { digit?: unknown } | null, i) => {
          if (typeof entry?.digit !== 'string') return;
          if (seen.has(entry.digit)) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'digit'],
              message: `keypad digit "${entry.digit}" is assigned twice`,
              params: { fix: 'give each menu entry its own digit, or delete the duplicate' },
            });
          }
          seen.add(entry.digit);
        });
      }))
      .describe('The keypad menu: digit to intent, in the order it is read out. May be empty for an app with no keypad menu.'),
  })
  .describe('intents.yaml: what a caller can ask for, and the keypad menu.');

export type IntentsYaml = z.infer<typeof intentsSchema>;
export type IntentYaml = IntentsYaml['intents'][string];

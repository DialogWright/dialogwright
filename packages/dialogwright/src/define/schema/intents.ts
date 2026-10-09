import { z } from 'zod';
import { REQUIRED_CONTROL_INTENTS } from '../../core/app/validate';
import { checkAlways, identifier, localeTag, matching, text } from './common';
import { KB_FILE_ID } from '../../kb/schema';

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
      .describe('form: starts the form of the same id in forms.yaml. informational: plays its promptId (or says its passage, or switches to its locale) and resumes. control: the engine\'s own (agent, repeat_prompt, done, other, none).'),
    promptId: identifier().optional().describe('For an informational intent, the prompt played (an id in prompts.yaml). An informational intent names this, `passage` or `locale` (`locale` may go with this).'),
    passage: matching(KB_FILE_ID, 'is not a valid passage id: it must start with a letter or digit and use only letters, digits, underscores, hyphens and dots', 'write the passage\'s id, its file name in kb/passages without .yaml (for example "opening-hours")')
      .optional()
      .describe(
        'For an informational intent, in place of promptId: a passage of the knowledge base (an id in kb/passages), said word for word through the kb_answer line. ' +
          'No retrieval and no gate: the passage in force today for its topic, in the call\'s language, for every caller (it has no applies). ' +
          'When none can be said, the kb_unavailable line is said and a person offered, once per call.',
      ),
    locale: localeTag()
      .optional()
      .describe(
        'For an informational intent: the locale the call switches to when it is chosen (one of the app\'s). Its promptId, if any, is said in that locale, then the call resumes; ' +
          'a speech channel is asked to switch its voice and recognition too (set_language, with the languages app.yaml\'s voice.locales names). Goes with promptId or alone, not with passage.',
      ),
    unsure: z
      .enum(['confirm', 'no-match'])
      .optional()
      .describe(
        'When the model is unsure of this intent (outside a form, read from INTENT_EXPLICIT, 0.4, up to INTENT_IMPLICIT, 0.6): "confirm" asks the caller ("Just to check, do you want to ...?"), ' +
          '"no-match" takes it as no match (the no-match line, counted). For a form intent, an informational one and done. Default: app.yaml\'s unsureIntent, else "confirm".',
      ),
    priority: z
      .union([
        z.boolean(),
        z.strictObject({
          threshold: matching(
            /^[A-Z][A-Z0-9_]*$/,
            'is not a threshold name: it must be upper case letters, digits and underscores, starting with a letter',
            'name one of the engine\'s thresholds (PRIORITY_INTENT) or one under thresholds in app.yaml',
          )
            .optional()
            .describe('The threshold the intent is read against in place of PRIORITY_INTENT: one of the engine\'s, or one under thresholds in app.yaml. Default PRIORITY_INTENT.'),
          correctsForm: z
            .boolean()
            .optional()
            .describe(
              'Before the priority form is entered, fill the slots the switching turn was asked about from its words, as a correction: the open form\'s, or the call\'s own slots when no form is open. ' +
                '"Water is coming through the wall right now", said at a read-back, replaces an urgency given earlier, so the handoff carries what the caller just said. Nothing is acknowledged, no check runs, and no question the model is sent changes. For a form intent. Default false.',
            ),
        }),
      ])
      .optional()
      .describe(
        'Something that must never wait or be missed, such as an emergency or a safety report. Read at PRIORITY_INTENT (0.8) or more, the intent is acted on this turn: ' +
          'mid-form over the question being answered and any pending confirmation (the form in hand is left, as on a switch), and never ignored as side speech or re-asked as unintelligible. ' +
          'A handoff to a person and the injection screen still stand. true reads PRIORITY_INTENT; { threshold: NAME } reads another; { correctsForm: true } also corrects what the call holds from the same words. For a form intent or an informational one. Default false.',
      ),
  })
  .check(checkAlways((value, ctx) => {
    const def = value as { kind?: unknown; promptId?: unknown; passage?: unknown; locale?: unknown; priority?: unknown } | null;
    if (typeof def !== 'object' || def === null) return;
    // "priority: high" or "priority: yes" (a string in YAML 1.2): the union alone would say only that it is no shape it knows.
    if (def.priority !== undefined && typeof def.priority !== 'boolean' && (typeof def.priority !== 'object' || def.priority === null || Array.isArray(def.priority))) {
      ctx.addIssue({
        code: 'custom',
        path: ['priority'],
        message: `"priority" is ${JSON.stringify(def.priority)}, which is not true, false or { threshold: NAME, correctsForm: true }`,
        params: { fix: 'write priority: true to read PRIORITY_INTENT, priority: { threshold: NAME } for another threshold, or priority: { correctsForm: true } to correct the form left from the same words' },
      });
    }
    if (def.kind === 'informational' && def.promptId === undefined && def.passage === undefined && def.locale === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'an informational intent plays a prompt, says a passage or switches the language, and this one names none of them',
        params: { fix: 'add "promptId: <id>" naming the prompt in prompts.yaml that this intent plays, "passage: <id>" naming a passage in kb/passages, or "locale: <tag>" naming the locale it switches to' },
      });
    }
    if (def.locale !== undefined && def.kind !== undefined && def.kind !== 'informational') {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: `locale is for an informational intent, and this one is of kind ${String(def.kind)}`,
        params: { fix: 'delete "locale", or make the intent kind: informational' },
      });
    }
    if (def.locale !== undefined && def.passage !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['locale'],
        message: 'an informational intent that switches the language says a prompt, not a passage',
        params: { fix: 'delete the passage, and name the line said in the new language with promptId' },
      });
    }
    if (def.promptId !== undefined && def.passage !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['passage'],
        message: 'an informational intent plays a prompt or says a passage, and this one names both',
        params: { fix: 'keep one: delete promptId to say the passage, or delete passage to play the prompt' },
      });
    }
    if (def.passage !== undefined && def.kind !== undefined && def.kind !== 'informational') {
      ctx.addIssue({
        code: 'custom',
        path: ['passage'],
        message: `only an informational intent says a passage, and this one is of kind ${String(def.kind)}`,
        params: { fix: 'delete the passage, or make the intent kind: informational' },
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

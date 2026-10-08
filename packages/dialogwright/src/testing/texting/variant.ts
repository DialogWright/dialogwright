import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineApp, type AppCode } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { TEXTING_DIR, textingCode, type TextingFacts } from './app';

/**
 * Variants of the fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code (or `code`). The fixture itself is never changed, so its own
 * calls and read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function textingVariants(): { variant(files: Record<string, (text: string) => string>, code?: AppCode): App; dirOf(app: App): string; remove(): void } {
  const dirs = new Map<string, string>();
  return {
    variant(files, code = textingCode) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-texting-'));
      cpSync(TEXTING_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      // A file the fixture does not have (a locale's prompts, say) starts empty.
      for (const [file, change] of Object.entries(files)) {
        const path = join(dir, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, change(existsSync(path) ? readFileSync(path, 'utf8') : ''));
      }
      const app = defineApp(dir, code);
      dirs.set(app.id, dir);
      return app;
    },
    dirOf(app) {
      const dir = dirs.get(app.id);
      if (dir === undefined) throw new Error(`no variant folder for the app "${app.id}"`);
      return dir;
    },
    remove() {
      for (const dir of dirs.values()) rmSync(dir, { recursive: true, force: true });
      dirs.clear();
    },
  };
}

/** Each change in turn, for a file two changes touch. */
export const both = (...changes: ((text: string) => string)[]) => (text: string): string => changes.reduce((t, change) => change(t), text);

/** A change to a file: `from` replaced by `to`, which must be there. */
export const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

/** The text slot's offer as the fixture writes it, which the variants below change. */
const TEXT_OFFER = "    countryCode: '1'\n    onNo: skip\n    ifNone: skip\n";

/**
 * The yes-or-no variant (design 2026-10-08-offer-answers-and-consent, item 1): the text offer takes
 * only a yes or a no (`answers: yes-no`). A number said at the offer is not taken, and with no clear yes
 * it is a no; on the keypad 1 is yes and 2 is no.
 */
export const YES_NO: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: texting', 'id: texting-yes-no'),
  'slots.yaml': replace(TEXT_OFFER, `${TEXT_OFFER}    answers: yes-no\n`),
};

/** The yes-or-no variant with a no that asks the slot's own question (`onNo: ask`, the default): a required offer. */
export const YES_NO_ASKS: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: texting', 'id: texting-yes-no-asks'),
  'slots.yaml': replace(TEXT_OFFER, "    countryCode: '1'\n    ifNone: skip\n    answers: yes-no\n"),
};

/** The second number the consent variant texts: alerts about the request, offered as the first is. */
const ALERT_SLOT = [
  'alertTo:',
  '  type: digits',
  '  noun: mobile number',
  '  length: 10',
  "  mask: '[2-9]\\d{9}'",
  '  keypad: true',
  '  group: [3, 3, 4]',
  '  callerNumber:',
  "    countryCode: '1'",
  '    onNo: skip',
  '    ifNone: skip',
  '',
].join('\n');

/** The lines the consent variant adds to prompts.yaml: the greeting's line, the consent question, the open question after it, and the second number's lines. */
export const CONSENT_LINES = [
  '  greeting_offer:',
  '    text: Thanks for calling Example Requests.',
  '    interruptible: true',
  '  consent_texts:',
  '    text: Can I text you helpful links during this call, at the number ending in {last4}?',
  '    interruptible: true',
  '  greet_after_offer:',
  '    text: What can I help you with today?',
  '    interruptible: true',
  '  ask_alertTo:',
  '    text: What mobile number should we text alerts to?',
  '    interruptible: true',
  '  ask_alertTo_retry:',
  "    text: Sorry, what's the ten-digit mobile number for alerts?",
  '    interruptible: true',
  '  ask_alertTo_dtmf:',
  '    text: Please key in the ten-digit mobile number for alerts on your keypad.',
  '    interruptible: true',
  '  offer_alertTo:',
  "    text: Can I text you alerts at the number you're calling from, ending in {last4}?",
  '    interruptible: true',
  '',
].join('\n');

/**
 * Corpus lines at the consent question just after the greeting (no_form, with `confirm` and no
 * `prompted`: harness-text/runner.ts seedTextConsent), and at the second number's offer.
 */
export const CONSENT_CORPUS = [
  '{"id":"tc-01","text":"sure, go ahead and text me","intent":"none","context":"no_form","confirm":"yes"}',
  '{"id":"tc-02","text":"no, don\'t text me","intent":"none","context":"no_form","confirm":"no"}',
  '{"id":"tc-03","text":"sure, and I\'d like to open a request","intent":"open_request","context":"no_form","confirm":"yes"}',
  '{"id":"tc-04","text":"actually, I need to open a request about a bill","intent":"open_request","context":"no_form","confirm":"unanswered","slots":{"topic":"bill"}}',
  '{"id":"al-01","text":"yes, alerts too","intent":"none","context":"open_request","prompted":"alertTo","confirm":"yes"}',
  '{"id":"tc-05","text":"yes, text five five five five five five zero one nine nine","intent":"none","context":"no_form","confirm":"yes","slots":{"textTo":{"span":"five five five five five five zero one nine nine","value":"5555550199"}}}',
  '{"id":"tc-06","text":"yes, text five five five five five five zero one four two","intent":"none","context":"no_form","confirm":"yes","slots":{"textTo":{"span":"five five five five five five zero one four two","value":"5555550142"}}}',
  '',
].join('\n');

/**
 * The consent variant (design 2026-10-08-offer-answers-and-consent, item 3): a second number to text
 * (`alertTo`, offered as `textTo` is), and consent to text for the whole call (app.yaml's
 * `textConsent`) covering both, asked once after the greeting on a call.
 */
export const CONSENT: Record<string, (text: string) => string> = {
  'app.yaml': both(replace('id: texting', 'id: texting-consent'), (t) => `${t}\ntextConsent:\n  covers: [textTo, alertTo]\n`),
  'slots.yaml': (t) => `${t}${ALERT_SLOT}`,
  'forms.yaml': replace('slots: [topic, textTo]', 'slots: [topic, textTo, alertTo]'),
  'prompts.yaml': (t) => `${t}${CONSENT_LINES}`,
  'fixtures/corpus.jsonl': (t) => `${t}${CONSENT_CORPUS}`,
};

/** The line the proposal variant adds to prompts.yaml: the topic proposed. */
const PROPOSAL_LINE = [
  '  offer_topic:',
  '    text: Is this about {topic}?',
  '    interruptible: true',
  '',
].join('\n');

/**
 * The consent variant with a proposal at the greeting as well (the topic, `offer: facts` with
 * `offerAt: greeting`, for a caller the call-start lookup found on a mobile): only one question follows
 * the greeting, and consent comes before a proposal, which is then made at its slot. Built with
 * proposingCode.
 */
export const CONSENT_AND_PROPOSAL: Record<string, (text: string) => string> = {
  ...CONSENT,
  'app.yaml': both(replace('id: texting', 'id: texting-consent-proposal'), (t) => `${t}\ntextConsent:\n  covers: [textTo, alertTo]\n`),
  'slots.yaml': both(
    replace('    instructions: Read asr.text. What does the caller say the request is about?\n', '    instructions: Read asr.text. What does the caller say the request is about?\n  offer: facts\n  offerAt: greeting\n'),
    (t) => `${t}${ALERT_SLOT}`,
  ),
  'prompts.yaml': (t) => `${t}${CONSENT_LINES}${PROPOSAL_LINE}`,
};

/** The fixture's code with a proposal of the topic for a caller on a mobile (FactsConfig.offers). */
export const proposingCode: AppCode = {
  ...textingCode,
  facts: {
    ...textingCode.facts!,
    offers: (f) => ((f as TextingFacts).lineType === 'mobile' ? { topic: { value: 'order', display: 'an order' } } : {}),
  },
};

/** The line said when the call switches to Spanish, in both locales. */
const SWITCHED_LINE = ['  switched_to_spanish:', '    text: Claro, seguimos en español.', '    interruptible: false', ''].join('\n');

/**
 * The consent variant with a Spanish locale and an informational intent that switches to it: the call
 * can move to Spanish after the grant, and a slot filled from it still records the line as it was said,
 * in English. Its Spanish prompts are the English ones but for the consent question and the switch.
 */
export const CONSENT_SPANISH: Record<string, (text: string) => string> = {
  ...CONSENT,
  'app.yaml': both(replace('id: texting', 'id: texting-consent-es'), (t) => `${t}\ntextConsent:\n  covers: [textTo, alertTo]\n`),
  'intents.yaml': replace('\nmenu:\n', [
    '  spanish:',
    '    kind: informational',
    '    label: continue in Spanish',
    '    criteria: The caller asks to continue in Spanish, or says they speak Spanish',
    '    locale: es',
    '    promptId: switched_to_spanish',
    '',
    'menu:',
    '',
  ].join('\n')),
  'prompts.yaml': (t) => `${t}${CONSENT_LINES}${SWITCHED_LINE}`,
  'locale/es/prompts.yaml': () => `${readFileSync(join(TEXTING_DIR, 'prompts.yaml'), 'utf8')}${CONSENT_LINES.replace('Can I text you helpful links during this call, at the number ending in {last4}?', '¿Puedo enviarle enlaces útiles durante esta llamada al número que termina en {last4}?')}${SWITCHED_LINE}`,
  'fixtures/corpus.jsonl': (t) => `${t}${CONSENT_CORPUS}{"id":"es-01","text":"can we continue in Spanish","intent":"spanish","context":"no_form"}\n`,
};

/** The fixture's code with a callerOffer hook that refuses the number for `refused` (and a landline, as the fixture's does). */
export const refusingCode = (refused: string): AppCode => ({
  ...textingCode,
  callerOffer: (ctx, slot) => slot !== refused && textingCode.callerOffer!(ctx, slot),
});

/**
 * The consent variant with a second form that texts the caller (`get_updates`, its one slot `textTo`,
 * no summary), so a call can reach a covered slot in two forms. Built with updatesCode.
 */
export const CONSENT_TWO_FORMS: Record<string, (text: string) => string> = {
  ...CONSENT,
  'app.yaml': both(replace('id: texting', 'id: texting-consent-two-forms'), (t) => `${t}\ntextConsent:\n  covers: [textTo, alertTo]\n`),
  'intents.yaml': replace('  agent:\n', [
    '  get_updates:',
    '    criteria: Wants text updates about their account, with no request to open',
    '    label: set up text updates',
    '    kind: form',
    '  agent:',
    '',
  ].join('\n')),
  'forms.yaml': (t) => `${CONSENT['forms.yaml']!(t)}  # Text updates about the account, to the number the caller agrees to; nothing to read back.\n  get_updates:\n    slots: [textTo]\n    summaryPromptId: null\n    hooks: [complete]\n    calls: []\n`,
  'prompts.yaml': (t) => `${t}${CONSENT_LINES}  updates_set:\n    text: Done, we'll text updates to {textTo}.\n    interruptible: false\n`,
  'fixtures/corpus.jsonl': (t) => `${t}${CONSENT_CORPUS}{"id":"gu-01","text":"I want text updates about my account","intent":"get_updates","context":"no_form"}\n`,
};

/** The fixture's code with the second form's completion: it says the number the updates go to. */
export const updatesCode: AppCode = {
  ...textingCode,
  forms: {
    ...textingCode.forms,
    get_updates: { complete: (c) => ({ kind: 'said', acks: [...c.acks, { promptId: 'updates_set', vars: { textTo: c.s.slots.textTo?.display ?? '' } }] }) },
  },
};

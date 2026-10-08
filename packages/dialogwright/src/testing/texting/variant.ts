import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
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

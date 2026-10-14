import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, policyCardText, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { MESSAGE_DIR, messageApp } from './app';
import { messageVariants, replace } from './variant';
import { afterAll } from 'vitest';

/**
 * The fixture's three read-back pages, the policy card listing the lines a model words and the
 * prescribed lines. Written with `pnpm policy:matrix`, `policy:card` and `app:diagram` on this folder; a test fails when
 * one is stale.
 */

resetAppsForTest();
registerApp(messageApp);

describe('the message fixture\'s pages', () => {
  it('its policy keeps the invariants', () => {
    expect(policyInvariants(messageApp).violations).toEqual([]);
  });
  it('policy.matrix', () => expectPolicyMatrix(messageApp, join(MESSAGE_DIR, 'policy.matrix')));
  it('POLICY.md', () => expectPolicyCard(messageApp, join(MESSAGE_DIR, 'POLICY.md')));
  it('APP-MAP.md', () => expectAppMap(messageApp, join(MESSAGE_DIR, 'APP-MAP.md')));
  it('the policy card lists every line a model words, and the prescribed lines', () => {
    const card = policyCardText(messageApp, MESSAGE_DIR);
    expect(card).toContain('## Lines a model words');
    // The read-back is framed: its summary a span a model words from the message, every other word fixed.
    expect(card).toContain('| Line | Fixed text | Span | Goal | Generated | Worded from | Sent whole, though recorded masked | Words |');
    expect(card).toContain("| `confirm_take_message` | Okay, thanks! I'll make sure {recipient} hears that {caller}, on {phone}, called and left this message: {summary}. Shall I pass it on? | `{summary}` |");
    expect(card).toContain('| `ask_caller` |');
    expect(card).toContain('| `message_taken` | Thanks, {caller}. Your message for {recipient} has been passed on. Your reference is {ref}. |');
    expect(card).not.toContain('| `ask_phone_dtmf` |');
  });
});

describe('the policy card\'s framed lines (review fixes)', () => {
  const variants = messageVariants();
  afterAll(() => variants.remove());
  it('names a judge cutoff other than the default plainly: above it, less cautious (style.yaml judge.refuseAt; live findings item 25)', () => {
    const at = (refuseAt: number) => policyCardText(variants.variant({ 'style.yaml': (t) => `${t.trimEnd()}\njudge:\n  refuseAt: ${refuseAt}\n` }), MESSAGE_DIR);
    expect(at(0.7)).toContain("refusing it at 0.7 or above (style.yaml's `judge.refuseAt`, less cautious than the default (0.5): more of what the judge doubts is said)");
    expect(at(0.3)).toContain("refusing it at 0.3 or above (style.yaml's `judge.refuseAt`, more cautious than the default (0.5))");
    expect(policyCardText(messageApp, MESSAGE_DIR)).toContain("refusing it at 0.5 or above (style.yaml's `judge.refuseAt`).");
  });
  it('says once that every other line is said word for word, after the framed lines', () => {
    const card = policyCardText(messageApp, MESSAGE_DIR);
    expect(card.match(/Every other line is said word for word\./g)).toHaveLength(1);
    expect(card).toMatch(/anything a tool returned\. Every other line is said word for word\./);
  });
  it('lists a span worded from a slot the records mask as sent whole', () => {
    const app = variants.variant({
      'app.yaml': replace('id: message', 'id: message-masked-span'),
      'prompts.yaml': (text) => replace('on {phone}, called', 'on {callback}, called')(replace(`        words: 25
`, `        words: 25
      callback:
        from: phone
        goal: Say the number to call back.
`)(text)),
    });
    resetAppsForTest();
    registerApp(app);
    const card = policyCardText(app, MESSAGE_DIR);
    expect(card).toContain('| Line | Fixed text | Span | Goal | Generated | Worded from | Sent whole, though recorded masked | Words |');
    expect(card).toMatch(/\| `\{callback\}` \| Say the number to call back\. \| the first time it is said \| `\{phone\}`, a value the caller confirms \| `\{phone\}` \| 25 \|/);
    expect(card).toMatch(/\| `\{summary\}` \| .* \| `\{message\}`, a value the caller confirms \| nothing \| 25 \|/);
    resetAppsForTest();
    registerApp(messageApp);
  });
});

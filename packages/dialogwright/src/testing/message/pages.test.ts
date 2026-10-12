import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { registerApp, resetAppsForTest } from '../../core/app/registry';
import { expectAppMap, policyCardText, expectPolicyCard, expectPolicyMatrix, policyInvariants } from '../index';
import { MESSAGE_DIR, messageApp } from './app';

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
    expect(card).toContain('| `confirm_take_message` |');
    expect(card).toContain('| `message_taken` | Thanks, {caller}. Your message for {recipient} has been passed on. Your reference is {ref}. |');
    expect(card).not.toContain('| `ask_phone_dtmf` |');
  });
});

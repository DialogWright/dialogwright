import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_THRESHOLDS } from './thresholds';
import { resolve, type TurnContext } from './turn';
import { keyEvents } from '../channel/events';
import { demoTools } from './tools';
import { newSession } from './session';
import { useTestkit } from '../testing/apps';
import { CUSTOMERS } from '../testing/testkit/domain/data';
import { customerPrincipal } from '../testing/testkit/domain/principals';
import { VOICE_RELAY } from '../channel/caps';

// A gate that echoes raw identity values back in the call on every decision it returns. The events
// the lifecycle records must carry the call it made, redacted, never whatever the gate hands back.
vi.mock('../gate/policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../gate/policy')>();
  return {
    ...real,
    evaluateCall: (...args: Parameters<typeof real.evaluateCall>) => {
      const d = real.evaluateCall(...args);
      return { ...d, call: { ...d.call, params: { ...d.call.params, accountId: '55501234', dob: '1985-04-12' } } };
    },
  };
});

useTestkit();

describe('the attempts probe', () => {
  it('is recorded like every other gate event: its own call, redacted', () => {
    const tc: TurnContext = { nowMs: 0, todayIso: '2026-09-18', thresholds: { ...DEFAULT_THRESHOLDS }, tools: demoTools() };
    const s = newSession('s', 0, VOICE_RELAY);
    s.principal = customerPrincipal(CUSTOMERS[0]!, 1);
    s.form = 'track_parcel';
    s.promptedFor = 'otp';
    s.identityAttempts.code = 2;
    // An odd last digit fails the code: the third failure, so the probe is refused on R6.
    let r = resolve(s, keyEvents('1')[0]!, null, tc);
    for (const f of keyEvents('11113')) r = resolve(r.session, f, null, tc);
    const probe = r.gateEvents.find((g) => g.decision.call.purpose === 'retry-check');
    expect(probe?.decision).toMatchObject({ verdict: 'NEEDS_HUMAN', call: { tool: 'verifyCode', params: {}, purpose: 'retry-check' } });
    const json = JSON.stringify(r.gateEvents);
    expect(json).not.toContain('55501234');
    expect(json).not.toContain('1985-04-12');
  });
});

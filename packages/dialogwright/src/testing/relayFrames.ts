import type { DtmfFrame, PromptFrame, SetupFrame, SignedInFrame } from '../channel/relay/frames';
import { DEFAULT_LANG } from '../channel/events';
import type { Principal } from '../gate/types';

// Constructors for the inbound frames only tests build. The relay's own code builds the server-made
// ones (silence, service_result) and the outbound ones (text, end) through channel/relay/frames.

export function promptFrame(text: string, last = true): PromptFrame {
  return { type: 'prompt', voicePrompt: text, lang: DEFAULT_LANG, last };
}

export function dtmfFrames(digits: string): DtmfFrame[] {
  return [...digits].map((digit) => ({ type: 'dtmf', digit }));
}

export function signedInFrame(principal: Principal): SignedInFrame {
  return { type: 'signed_in', principal };
}

export function setupFrame(sessionId: string): SetupFrame {
  return {
    type: 'setup',
    sessionId,
    callSid: `CA-${sessionId}`,
    from: '+15550000001',
    to: '+15550000002',
    customParameters: {},
  };
}

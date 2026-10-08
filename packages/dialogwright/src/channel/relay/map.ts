import { endFrame, textFrame, type InboundFrame, type OutboundFrame } from './frames';
import type { Action } from '../actions';
import type { SessionEvent } from '../events';

const INBOUND_TYPES: Record<InboundFrame['type'], true> = {
  setup: true, prompt: true, dtmf: true, interrupt: true, error: true, silence: true, service_result: true, signed_in: true,
};

/** Whether `type` names an inbound frame frameToEvent can map (a log or trace may hold anything). */
export function isInboundFrameType(type: unknown): type is InboundFrame['type'] {
  return typeof type === 'string' && Object.hasOwn(INBOUND_TYPES, type);
}

/**
 * The core's event for a ConversationRelay message (or a server-made frame read back from a log).
 * A setup's call ids and custom parameters become the event's opaque provider details, the
 * parameters prefixed `param.`; the core reads none of them. A custom parameter named `locale` (a
 * `<Parameter name="locale" value="es-US"/>` in the TwiML that opened the relay) is also the
 * locale the session is asked to speak (SessionStart.locale).
 */
export function frameToEvent(f: InboundFrame): SessionEvent {
  switch (f.type) {
    case 'setup': {
      const { type: _type, customParameters, ...ids } = f;
      const provider: Record<string, string> = {};
      for (const [k, v] of Object.entries(ids)) if (typeof v === 'string') provider[k] = v;
      if (typeof customParameters === 'object' && customParameters !== null) for (const [k, v] of Object.entries(customParameters)) provider[`param.${k}`] = v;
      const locale = typeof customParameters === 'object' && customParameters !== null && Object.hasOwn(customParameters, 'locale') ? customParameters.locale : undefined;
      return typeof locale === 'string' ? { type: 'session.start', provider, locale } : { type: 'session.start', provider };
    }
    case 'prompt': return { type: 'user.speech', text: f.voicePrompt, final: f.last, lang: f.lang };
    case 'dtmf': return { type: 'user.key', digit: f.digit };
    case 'interrupt': return { type: 'user.interrupt', heard: f.utteranceUntilInterrupt, afterMs: f.durationUntilInterruptMs };
    case 'error': return { type: 'channel.error', description: f.description };
    case 'silence': return { type: 'user.silence' };
    case 'service_result': return { type: 'service.result', service: f.service, result: f.result, ...(f.note ? { note: f.note } : {}) };
    case 'signed_in': return { type: 'auth.signed_in', principal: f.principal };
  }
}

/** Twilio ConversationRelay frames for the core's actions; byte for byte what the core used to emit. */
export function actionsToFrames(actions: readonly Action[]): OutboundFrame[] {
  return actions.flatMap((a): OutboundFrame[] => {
    switch (a.type) {
      case 'say':
        return a.parts.map((p) => ('text' in p
          ? textFrame(p.text, a.interruptible, a.lang)
          : { type: 'play', source: p.audio, loop: 1, preemptible: false, interruptible: a.interruptible }));
      case 'end':
        return [endFrame('completed', a.completed)];
      case 'transfer':
        return [endFrame(a.reason, a.completed, a.queued, a.slots, a.unconfirmed)];
      case 'send_digits':
        return [{ type: 'sendDigits', digits: a.digits }];
      case 'set_language':
        return [{ type: 'language', ttsLanguage: a.tts, transcriptionLanguage: a.transcription }];
    }
  });
}

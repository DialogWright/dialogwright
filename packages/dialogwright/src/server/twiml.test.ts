import { describe, expect, it } from 'vitest';
import { connectRelayTwiml, dialTwiml, hangupTwiml, apologizeAndDialTwiml, escapeXml } from './twiml';
import { buildHints } from './hints';
import { testkitApp } from '../testing/testkit';

describe('twiml', () => {
  it('builds the ConversationRelay connect document with our attributes', () => {
    const xml = connectRelayTwiml({ publicHost: 'demo.ngrok.app', token: 'abc', hints: 'parcel, delivery' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(xml).toContain('<Connect action="https://demo.ngrok.app/cr-action">');
    expect(xml).toContain('url="wss://demo.ngrok.app/conversation?token=abc"');
    for (const attr of [
      'transcriptionProvider="Deepgram"', 'speechModel="flux"', 'partialPrompts="true"', 'dtmfDetection="true"',
      'interruptible="any"', 'interruptSensitivity="low"', 'ignoreBackchannel="true"', 'reportInputDuringAgentSpeech="any"',
      'deepgramSmartFormat="false"', 'hints="parcel, delivery"',
    ]) expect(xml).toContain(attr);
    expect(xml.endsWith('</Response>')).toBe(true);
  });

  it('escapes attribute values', () => {
    expect(connectRelayTwiml({ publicHost: 'h', token: 'a&b', hints: 'x<y' })).toContain('token=a&amp;b');
    expect(escapeXml('"q" & <t>')).toBe('&quot;q&quot; &amp; &lt;t&gt;');
  });

  it('adds ttsProvider and voice only when configured', () => {
    expect(connectRelayTwiml({ publicHost: 'h', token: 't', hints: '' })).not.toMatch(/ttsProvider|voice=/);
    const x = connectRelayTwiml({ publicHost: 'h', token: 't', hints: '', ttsProvider: 'Google', voice: 'en-US-Neural2-F' });
    expect(x).toContain('ttsProvider="Google"');
    expect(x).toContain('voice="en-US-Neural2-F"');
    const escaped = connectRelayTwiml({ publicHost: 'h', token: 't', hints: '', ttsProvider: 'Google', voice: 'a "quoted" & name' });
    expect(escaped).toContain('voice="a &quot;quoted&quot; &amp; name"');
  });

  it('builds dial, hangup and apologize documents', () => {
    expect(dialTwiml('+15551234567')).toContain('<Dial>+15551234567</Dial>');
    expect(hangupTwiml()).toContain('<Hangup/>');
    const a = apologizeAndDialTwiml('+15551234567');
    expect(a).toContain('<Say>');
    expect(a).toContain('<Dial>+15551234567</Dial>');
  });
});

describe('buildHints', () => {
  it("lists the app's vocabulary and number words", () => {
    const hints = buildHints(testkitApp);
    for (const w of ['parcel', 'delivery', 'tracking', 'missing']) expect(hints).toContain(w);
    for (const w of ['account ID', 'morning', 'representative', 'zero', 'nine']) expect(hints).toContain(w);
    expect(hints).not.toContain('"');
  });

  it('lists only the number words for an app with no hints of its own', () => {
    expect(buildHints()).toBe('zero, oh, one, two, three, four, five, six, seven, eight, nine, double');
  });
});

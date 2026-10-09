import { parseInbound, serializeOutbound } from '../channel/relay/wire';
import { frameToEvent } from '../channel/relay/map';
import type { OutboundFrame } from '../channel/relay/frames';
import type { TestRegistrar } from '../slots/conformance/run';
import type { VoiceProvider, WebhookRequest } from '../server/voice/provider';
import { callDataFrom, webhookParameters, webhookParameterName } from '../channel/callData';
import { escapeXml } from '../server/voice/xml';

/** One frame as the carrier documents (or a capture shows) it: where it came from, and which way it goes. */
export interface FrameFixture {
  /** The doc URL it was copied from, or `captured <date>`, with any change made to it (numbers made fictional, say). */
  source: string;
  dir: 'in' | 'out';
  frame: Record<string, unknown>;
}

/** One webhook as the carrier sends it, and what the provider must read from it. */
export interface WebhookFixture {
  /** The doc URL, `captured <date>`, or `ASSUMED: ...` when the carrier does not document it. */
  source: string;
  headers: Record<string, string>;
  rawBody: string;
  /** The CallbackParams fields the provider must read (callId, from, callStatus, live, handoffData, ...). */
  expect: Record<string, string | boolean>;
}

/** Which custom parameter and which answer webhook field the call data check reads, and where that is documented or seen. */
export interface CallDataFixture {
  /** The doc URL, `captured <date>`, or `ASSUMED: ...` when the carrier does not document it. */
  source: string;
  /** A custom parameter of a setup frame in the fixtures. */
  param?: string;
  /** A field of the voice webhook fixture. */
  webhookField?: string;
}

export interface VoiceFixtures {
  frames: readonly FrameFixture[];
  /** The webhook that answers a call (POST /voice/<id>). */
  voice: WebhookFixture;
  /** The relay's end-of-session callback (POST /cr-action/<id>). */
  action: WebhookFixture;
  /**
   * The call data a carrier brings (app.yaml's callData): a custom parameter of a setup frame in
   * `frames`, and a field of the `voice` webhook, which the start document echoes back. Each name is
   * optional: absent, the first custom parameter of the first setup that has one, and the first field
   * of the voice webhook that is not its call id.
   */
  callData?: CallDataFixture;
  /** Other forms the carrier may send the same webhooks in, each read as `expect` says. */
  alternatives?: readonly WebhookFixture[];
  /** Signs a webhook the way the carrier does, with a key or token made in the test; never a stored secret. */
  sign(req: WebhookRequest): { headers: Record<string, string>; secret: string };
}

/** The event types a carrier's own frames may become; everything else the core reads is server-made. */
const CARRIER_EVENTS = new Set(['session.start', 'user.speech', 'user.key', 'user.interrupt', 'channel.error']);
/** The outbound frame types the engine sends. */
const ENGINE_OUTBOUND = new Set<string>(['text', 'play', 'sendDigits', 'language', 'end']);
const HOST = 'voice.example.com';
const NOW_SEC = 1_700_000_000;

function fail(message: string): never {
  throw new Error(message);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Each check of the kit, by name, so a runner other than `runVoiceProviderConformance` can call them. */
export function voiceConformanceChecks(provider: VoiceProvider, fx: VoiceFixtures): { name: string; run(): void }[] {
  const inbound = fx.frames.filter((f) => f.dir === 'in');
  const outbound = fx.frames.filter((f) => f.dir === 'out');
  const label = (f: FrameFixture) => `${f.source}: ${JSON.stringify(f.frame)}`;
  return [
    {
      name: 'parses every inbound frame the carrier documents into a core event',
      run() {
        if (inbound.length === 0) fail('no inbound frames in the fixtures');
        for (const f of inbound) {
          const parsed = parseInbound(JSON.stringify(f.frame));
          if (parsed === null) fail(`refused by parseInbound: ${label(f)}`);
          const event = frameToEvent(parsed);
          if (!CARRIER_EVENTS.has(event.type)) fail(`became ${event.type}, not a carrier event: ${label(f)}`);
        }
      },
    },
    {
      name: 'keeps every call id and number a setup frame carries as the session\'s provider details',
      run() {
        const setups = inbound.filter((f) => f.frame.type === 'setup');
        if (setups.length === 0) fail('no setup frame in the fixtures');
        for (const f of setups) {
          const parsed = parseInbound(JSON.stringify(f.frame));
          const event = parsed && frameToEvent(parsed);
          if (event?.type !== 'session.start') fail(`not a session start: ${label(f)}`);
          for (const [k, v] of Object.entries(f.frame)) {
            if (k === 'type' || typeof v !== 'string') continue;
            if (event.provider[k] !== v) fail(`setup field "${k}" is not kept (got ${JSON.stringify(event.provider[k])}): ${f.source}`);
          }
        }
      },
    },
    {
      name: 'brings a custom parameter and a named answer webhook field to the session as call data',
      run() {
        const setup = inbound.find((f) => f.frame.type === 'setup' && typeof f.frame.customParameters === 'object' && f.frame.customParameters !== null && Object.keys(f.frame.customParameters).length > 0);
        if (setup === undefined) fail('no setup frame with a custom parameter in the fixtures: add one, as the carrier documents a <Parameter> coming back');
        const params = setup.frame.customParameters as Record<string, unknown>;
        const param = fx.callData?.param ?? Object.keys(params)[0]!;
        if (typeof params[param] !== 'string') fail(`custom parameter "${param}" is not a string on the setup: ${setup.source}`);
        const hook = provider.parse({ url: `/voice/${provider.id}`, headers: fx.voice.headers, rawBody: fx.voice.rawBody, nowSec: NOW_SEC });
        if (hook === null) fail(`named no call: ${fx.voice.source}`);
        const field = fx.callData?.webhookField ?? Object.keys(hook.raw).find((k) => hook.raw[k] !== hook.callId && hook.raw[k] !== '');
        if (field === undefined || typeof hook.raw[field] !== 'string' || hook.raw[field] === '') fail(`the voice webhook carries no field "${field ?? ''}" to echo (CallbackParams.raw): ${fx.voice.source}`);
        const spec = { fromParam: { from: `param.${param}` }, fromWebhook: { from: `webhook.${field}` } };
        const echoes = webhookParameters(spec, hook.raw);
        const name = webhookParameterName('fromWebhook');
        if (echoes[name] !== hook.raw[field]) fail(`the webhook field "${field}" is not echoed as ${name}`);
        const doc = provider.startDocument({ publicHost: HOST, token: 'c'.repeat(32), hints: '', parameters: echoes });
        if (!doc.includes(name) || !doc.includes(escapeXml(hook.raw[field]!))) fail(`start document does not carry ${name} with the field's value: ${doc}`);
        // The carrier hands the document's parameters back on the setup, beside its own.
        const back = parseInbound(JSON.stringify({ ...setup.frame, customParameters: { ...params, ...echoes } }));
        const event = back && frameToEvent(back);
        if (event?.type !== 'session.start') fail(`not a session start: ${setup.source}`);
        const data = callDataFrom(spec, event.provider);
        const want = { fromParam: params[param], fromWebhook: hook.raw[field] };
        if (!same(data, want)) fail(`call data read as ${JSON.stringify(data)}, expected ${JSON.stringify(want)}: ${fx.callData?.source ?? setup.source}`);
      },
    },
    {
      name: 'serializes every outbound frame the carrier documents with the same fields and values',
      run() {
        if (outbound.length === 0) fail('no outbound frames in the fixtures');
        for (const f of outbound) {
          if (!ENGINE_OUTBOUND.has(String(f.frame.type))) fail(`not a frame type the engine sends: ${label(f)}`);
          const out = JSON.parse(serializeOutbound(f.frame as unknown as OutboundFrame)) as Record<string, unknown>;
          for (const [k, v] of Object.entries(f.frame)) {
            if (!same(out[k], v)) fail(`field "${k}" serialized as ${JSON.stringify(out[k])}, documented ${JSON.stringify(v)}: ${f.source}`);
          }
        }
      },
    },
    {
      name: 'verifies its own signature and refuses a tampered body, another key and no signature',
      run() {
        for (const w of [fx.voice, fx.action]) {
          const req: WebhookRequest = { url: `/voice/${provider.id}`, headers: w.headers, rawBody: w.rawBody, nowSec: NOW_SEC };
          const { headers, secret } = fx.sign(req);
          const signed = { ...req, headers: { ...req.headers, ...headers } };
          if (!provider.verify(signed, secret, HOST)) fail(`refused its own signature: ${w.source}`);
          if (provider.verify({ ...signed, rawBody: `${req.rawBody}x` }, secret, HOST)) fail(`accepted a tampered body: ${w.source}`);
          if (provider.verify(req, secret, HOST)) fail(`accepted a webhook with no signature: ${w.source}`);
          const other = fx.sign({ ...req, rawBody: `${req.rawBody}&other=1` });
          if (provider.verify({ ...req, headers: { ...req.headers, ...other.headers } }, secret, HOST)) fail(`accepted another body's signature: ${w.source}`);
        }
      },
    },
    {
      name: 'reads the voice and action webhooks into the engine terms',
      run() {
        for (const w of [fx.voice, fx.action, ...(fx.alternatives ?? [])]) {
          const p = provider.parse({ url: `/voice/${provider.id}`, headers: w.headers, rawBody: w.rawBody, nowSec: NOW_SEC });
          if (p === null) fail(`named no call: ${w.source}`);
          for (const [k, v] of Object.entries(w.expect)) {
            const got = (p as unknown as Record<string, unknown>)[k];
            if (got !== v) fail(`read ${k} as ${JSON.stringify(got)}, expected ${JSON.stringify(v)}: ${w.source}`);
          }
        }
      },
    },
    {
      name: 'starts the relay at its own socket and action paths, with keypad detection on',
      run() {
        const token = 'c'.repeat(32);
        const doc = provider.startDocument({ publicHost: HOST, token, hints: 'one,two' });
        for (const part of [`wss://${HOST}/conversation/${provider.id}?token=${token}`, `https://${HOST}/cr-action/${provider.id}`, 'dtmfDetection="true"']) {
          if (!doc.includes(part)) fail(`start document lacks ${part}: ${doc}`);
        }
        if (provider.startDocument({ publicHost: HOST, token: 'a&b', hints: '' }).includes('token=a&b')) fail('start document does not escape its values');
      },
    },
    {
      name: 'ends a call with a hangup, and dials the handoff number',
      run() {
        if (!provider.hangupDocument().includes('<Hangup/>')) fail(`hangup document: ${provider.hangupDocument()}`);
        if (!provider.dialDocument('+15555550199').includes('+15555550199')) fail(`dial document: ${provider.dialDocument('+15555550199')}`);
        if (!provider.apologizeAndDialDocument('+15555550199').includes('+15555550199')) fail('apologize-and-dial document does not dial');
        if (!/^[a-z]+\/[a-z+.-]+$/.test(provider.contentType)) fail(`content type: ${provider.contentType}`);
      },
    },
  ];
}

/**
 * What every voice provider must do, run against the carrier's own documented (or captured) frames
 * and webhooks. A new carrier passes this before it is listed in VOICE_PROVIDERS. The runner's
 * `describe` and `it` are passed in, so importing the kit loads no test runner:
 *
 *   import { describe, it } from 'vitest';
 *   import { runVoiceProviderConformance } from 'dialogwright/testing';
 *   runVoiceProviderConformance(myProvider, { describe, it, ...myFixtures });
 */
export function runVoiceProviderConformance(provider: VoiceProvider, options: TestRegistrar & VoiceFixtures): void {
  const { describe, it, ...fx } = options;
  describe(`voice provider conformance: ${provider.id}`, () => {
    for (const check of voiceConformanceChecks(provider, fx)) it(check.name, check.run);
  });
}

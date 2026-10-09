import { escapeXml } from './xml';

/**
 * Where a carrier's document dials (VoiceProvider.dialDocument, apologizeAndDialDocument): an E.164
 * number or a `sip:` URI, and the SIP headers for a `sip:` one.
 *
 * What the carriers document of a transfer to a SIP address with headers:
 * - Twilio (TwiML `<Dial><Sip>`, twilio.com/docs/voice/twiml/sip): "Send custom headers by appending them
 *   to the SIP URI, just as you'd pass headers in a URI over HTTP", as `sip:jack@example.com?x-mycustomheader=foo&x-myotherheader=bar`
 *   (the `&` written `&amp;` in the XML). "Any headers starting with the x- prefix can be sent this way";
 *   User-to-User can be sent without it (`User-to-User=123456789%3Bencoding%3Dhex`), and so can
 *   Remote-Party-ID, P-Preferred-Identity and P-Called-Party-ID (which a transfer here does not send).
 *   The examples percent-encode reserved characters. "While the SIP URI itself must be under 255 chars,
 *   the headers must be under 1024 characters."
 * - Telnyx (TeXML `<Dial><Sip>`, developers.telnyx.com, TeXML verbs, Dial): `<Sip>` takes a SIP URI and
 *   attributes for authentication, callbacks, answering machine detection and region; its page says
 *   nothing of custom headers. ASSUMED, until a live call shows it (docs/live-checks.md): that TeXML reads
 *   headers appended to the `<Sip>` URI as Twilio's TwiML does, which its TwiML-compatible verbs suggest,
 *   and holds them to the same limits. Telnyx's custom header article says headers prefixed X-Telnyx are
 *   its own (`pnpm check` warns of one), and that custom headers reach a SIP endpoint on the same Telnyx
 *   account or one outside Telnyx, never the public phone network.
 * So both providers write the same `<Dial><Sip>sip:...?Name=value&amp;...</Sip></Dial>`, each value
 * percent-encoded, and the headers are held to the stricter limit, under 1024 characters in all.
 * A phone number takes no headers on either carrier.
 */
export interface DialTarget {
  /** An E.164 number, or a `sip:` URI. */
  readonly to: string;
  /** SIP headers by name, for a `sip:` target only; a number's are never written. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** The most characters the headers may take once encoded (`a=b&c=d`): Twilio's "under 1024". */
export const SIP_HEADERS_MAX = 1023;

/** The longest SIP URI a target may be, its headers apart: Twilio's "under 255 chars". */
export const SIP_URI_MAX = 254;

/** Whether a target is a SIP address (`sip:`), which takes headers, rather than a phone number. */
export function isSipTarget(to: string): boolean {
  return /^sip:/i.test(to);
}

/** One header as the URI carries it: its name, and its value percent-encoded. */
export function encodedHeader(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`;
}

/** A `sip:` URI with its headers appended (after `?`, or `&` where the URI has headers of its own). */
export function sipUriWithHeaders(to: string, headers: Readonly<Record<string, string>> = {}): string {
  const parts = Object.entries(headers).map(([n, v]) => encodedHeader(n, v));
  if (parts.length === 0) return to;
  return `${to}${to.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

/** The headers a target's URI already has (anything after its `?`), counted against the limit. */
function ownHeaders(to: string): string {
  const at = to.indexOf('?');
  return at < 0 ? '' : to.slice(at + 1);
}

/**
 * The headers a target can carry, in order, and those it cannot: all of them for a phone number
 * (`number`), and for a `sip:` URI those that would take the encoded headers past SIP_HEADERS_MAX
 * (`size`), each left out whole and the rest still tried.
 */
export function fitHeaders(to: string, headers: Readonly<Record<string, string>> = {}): { kept: Record<string, string>; dropped: string[]; why?: 'number' | 'size' } {
  const names = Object.keys(headers);
  if (names.length === 0) return { kept: {}, dropped: [] };
  if (!isSipTarget(to)) return { kept: {}, dropped: names, why: 'number' };
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  let used = ownHeaders(to).length;
  for (const name of names) {
    const part = encodedHeader(name, headers[name]!);
    const cost = (used > 0 ? 1 : 0) + part.length;
    if (used + cost > SIP_HEADERS_MAX) dropped.push(name);
    else {
      kept[name] = headers[name]!;
      used += cost;
    }
  }
  return dropped.length > 0 ? { kept, dropped, why: 'size' } : { kept, dropped };
}

/**
 * The `<Dial>` verb both carriers take: a number as the dial's text, as it always was; a `sip:` URI in a
 * `<Sip>` noun with its headers appended, as many as fit (fitHeaders). Headers on a number are never written.
 */
export function dialVerb(target: DialTarget): string {
  if (!isSipTarget(target.to)) return `<Dial>${escapeXml(target.to)}</Dial>`;
  return `<Dial><Sip>${escapeXml(sipUriWithHeaders(target.to, fitHeaders(target.to, target.headers).kept))}</Sip></Dial>`;
}

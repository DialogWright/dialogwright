import { TELNYX_MEDIA_PREFIX } from './telnyx';
import { TWILIO_MEDIA_PREFIX } from './twilio';

/** Where each provider keeps a text's media (Twilio's and Telnyx's own): the only media URLs a text that comes in keeps. */
export const PROVIDER_MEDIA_PREFIXES: readonly string[] = Object.freeze([TWILIO_MEDIA_PREFIX, TELNYX_MEDIA_PREFIX]);

/** Whether a URL is a provider's own media (PROVIDER_MEDIA_PREFIXES), as a text that came in may carry: an app shows or forwards no other. */
export function providerMedia(url: string): boolean {
  return PROVIDER_MEDIA_PREFIXES.some((p) => url.startsWith(p));
}

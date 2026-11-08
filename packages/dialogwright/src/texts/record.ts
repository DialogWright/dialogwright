import type { AuditDraft } from '../audit/types';
import { lastFour } from '../core/callerNumber';
import { sameNumber } from '../core/conditions';
import type { TextLimitSettings } from './settings';
import type { IncomingText, OutgoingText, TextProvider, TextReceipt, TextRecord, Texts } from './types';

/** How many texts' keys a server keeps, so a send repeated with its key is not sent twice (the oldest let go first). */
export const TEXT_KEYS_KEPT = 2000;

/** The receipts of texts sent with a key (OutgoingText.key), the latest TEXT_KEYS_KEPT, for one app on one server. */
export class TextKeys {
  private readonly kept = new Map<string, TextReceipt>();
  get(key: string): TextReceipt | undefined {
    return this.kept.get(key);
  }
  set(key: string, receipt: TextReceipt): void {
    this.kept.set(key, receipt);
    if (this.kept.size > TEXT_KEYS_KEPT) this.kept.delete(this.kept.keys().next().value!);
  }
}

/** A day and an hour, ms: the windows the abuse limits count in. */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The sender's abuse limits for one app on one server (the design's call 46): at most `perNumber` texts to
 * one number in the last 24 hours (a number `exempt` lists, the business's own phone, is not held to it)
 * and `perHour` texts in all in the last hour. A send over either is refused before it reaches the
 * provider (TextReceipt `limited`), so a caller who makes the line text a number again and again, or a
 * flood of texts from many, costs at most this. In memory: a server restarted counts again.
 */
export class TextLimits {
  private readonly sent: { at: number; to: string }[] = [];
  constructor(readonly settings: TextLimitSettings, private readonly now: () => number = () => Date.now()) {}

  /** Why a text to `to` is refused now ("3 to ...0177 in 24 hours"), or null where it may go; a text that may go is counted. */
  take(to: string): string | null {
    const at = this.now();
    while (this.sent.length > 0 && this.sent[0]!.at <= at - DAY_MS) this.sent.shift();
    const hour = this.sent.filter((x) => x.at > at - HOUR_MS).length;
    if (hour >= this.settings.perHour) return `limit: ${this.settings.perHour} texts an hour (TEXT_LIMIT_PER_HOUR)`;
    const exempt = this.settings.exempt.some((n) => sameNumber(to, n));
    if (!exempt && this.sent.filter((x) => sameNumber(x.to, to)).length >= this.settings.perNumber) return `limit: ${this.settings.perNumber} texts to one number in 24 hours (TEXT_LIMIT_PER_NUMBER)`;
    this.sent.push({ at, to });
    return null;
  }
}

/** A number by its last four, as a text's record keeps it ("...0177"). */
export const numberRecorded = (n: string): string => `...${lastFour(n)}`;

/** A text sent, as it is recorded. */
export function sentRecord(provider: string, text: OutgoingText, receipt: TextReceipt): TextRecord {
  return {
    direction: 'sent', number: numberRecorded(text.to), bodyLength: text.body.length, media: text.media?.length ?? 0, id: receipt.id, status: receipt.status,
    ...(receipt.error !== undefined ? { error: receipt.error } : {}), ...(receipt.repeat ? { repeat: true as const } : {}), provider,
  };
}

/** A text received, as it is recorded: from by its last four, the media by their count; no words and no media URL. */
export function receivedRecord(m: IncomingText, extra: { mediaDropped?: number; unrouted?: true } = {}): TextRecord {
  return {
    direction: 'received', number: numberRecorded(m.from), bodyLength: m.body.length, media: m.media.length, id: m.id, status: 'received', provider: m.provider,
    ...(extra.mediaDropped !== undefined && extra.mediaDropped > 0 ? { mediaDropped: extra.mediaDropped } : {}), ...(extra.unrouted === true ? { unrouted: true as const } : {}),
  };
}

/** A text's audit row: `text_sent` or `text_received`, with the record's fields. */
export function textAuditRow(r: TextRecord): AuditDraft {
  const detail: AuditDraft['detail'] = { number: r.number, bodyLength: r.bodyLength, media: r.media, id: r.id, status: r.status, provider: r.provider };
  if (r.error !== undefined) detail.error = r.error;
  if (r.repeat) detail.repeat = true;
  if (r.mediaDropped !== undefined) detail.mediaDropped = r.mediaDropped;
  if (r.unrouted) detail.unrouted = true;
  return { type: r.direction === 'sent' ? 'text_sent' : 'text_received', detail };
}

/**
 * The sender an app's code is given (Texts): `provider` from `from`, each text recorded through `record`
 * as it is sent, a text with a key it has sent before not sent again (`keys`). A provider that throws is a
 * failed receipt, never a throw into the app's code.
 */
export function recordingTexts(provider: TextProvider, from: string, keys: TextKeys, record: (r: TextRecord) => void, limits: TextLimits | null = null): Texts {
  return {
    async send(text: OutgoingText): Promise<TextReceipt> {
      const before = text.key !== undefined ? keys.get(text.key) : undefined;
      if (before !== undefined && before.status !== 'failed' && before.status !== 'limited') {
        const repeat: TextReceipt = { ...before, repeat: true };
        record(sentRecord(provider.id, text, repeat));
        return repeat;
      }
      // Over an abuse limit: refused before the provider, recorded `limited`, never retried.
      const over = limits?.take(text.to) ?? null;
      if (over !== null) {
        const refused: TextReceipt = { id: null, status: 'limited', error: over };
        record(sentRecord(provider.id, text, refused));
        return refused;
      }
      let receipt: TextReceipt;
      try {
        receipt = await provider.send({ ...text, from });
      } catch (err) {
        receipt = { id: null, status: 'failed', error: err instanceof Error ? err.name : 'error' };
      }
      if (text.key !== undefined && receipt.status !== 'failed' && receipt.status !== 'limited') keys.set(text.key, receipt);
      record(sentRecord(provider.id, text, receipt));
      return receipt;
    },
  };
}

/** A text the fake sender took (fakeTextProvider), whole: a test reads it. */
export interface FakeSent extends OutgoingText {
  readonly from: string;
}

/**
 * A sender for tests: it takes every text and answers `queued` with an id of its own (`SMfake<n>`), keeping
 * each whole in `sent`. Never a real provider: no test sends a text.
 */
export function fakeTextProvider(o: { fail?: (t: OutgoingText) => boolean } = {}): TextProvider & { readonly sent: FakeSent[] } {
  const sent: FakeSent[] = [];
  return {
    id: 'fake',
    sent,
    async send(text) {
      if (o.fail?.(text) === true) return { id: null, status: 'failed', error: 'HTTP 400 21211: invalid number' };
      sent.push({ ...text, ...(text.media !== undefined ? { media: [...text.media] } : {}) });
      return { id: `SMfake${sent.length}`, status: 'queued' };
    },
  };
}

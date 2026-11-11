/**
 * Provider endpoints and the safe account of a failed request: a leaf module (it imports nothing of the
 * engine), read by the scripted engine's render clients and by the converse model client alike.
 */

/** Each provider's endpoint, key variable and default model. */
export const KNOWN: Record<'openrouter' | 'anthropic' | 'inception', { url: string; keyVar: string; model: string }> = {
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', keyVar: 'OPENROUTER_API_KEY', model: 'anthropic/claude-haiku-5.5' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', keyVar: 'ANTHROPIC_API_KEY', model: 'claude-haiku-5-5' },
  inception: { url: 'https://api.inceptionlabs.ai/v1/chat/completions', keyVar: 'INCEPTION_API_KEY', model: 'mercury-3' },
};

/** The API's own account of a failed request (its error's type and message), made safe to record: one line, short, no key. */
export function apiError(json: unknown, key: string): { type?: string; message?: string } {
  const e = (json as { error?: unknown } | null)?.error;
  // A body that is not OpenAI's shape (FastAPI's `{ "detail": ... }`, as Inception's may be): its detail as the message.
  if (e === undefined) {
    const detail = detailOf((json as { detail?: unknown } | null)?.detail);
    return detail !== null ? { message: safeErrorText(detail, key) } : {};
  }
  if (e === null || typeof e !== 'object') return {};
  const o = e as { type?: unknown; code?: unknown; message?: unknown; metadata?: unknown };
  // Anthropic's error has a type; OpenRouter's a code, which may be the HTTP status again (a number:
  // then nothing is added to the status), or a name.
  const type = typeof o.type === 'string' ? o.type : typeof o.code === 'string' ? o.code : undefined;
  const own = typeof o.message === 'string' && o.message.trim() !== '' ? o.message : null;
  const upstream = upstreamError(o.metadata);
  const message = own !== null && upstream !== null ? `${own} (${upstream})` : own ?? upstream;
  return { ...(type !== undefined && WORD.test(type) ? { type } : {}), ...(message !== null ? { message: safeErrorText(message, key) } : {}) };
}

/** A `detail` field's text: a string, or a validation error's list read by each item's `msg` alone (never its `input`). */
function detailOf(d: unknown): string | null {
  if (typeof d === 'string') return d.trim() !== '' ? d : null;
  if (!Array.isArray(d)) return null;
  const msgs = d.map((i) => (i !== null && typeof i === 'object' && typeof (i as { msg?: unknown }).msg === 'string' ? (i as { msg: string }).msg : null)).filter((m): m is string => m !== null && m.trim() !== '');
  return msgs.length > 0 ? msgs.join('; ') : null;
}

/** A word an error may name as it is: a type, a code, a provider. */
const WORD = /^[A-Za-z0-9_.-]{1,64}$/;

/** The longest provider message kept: a sentence saying why, never a payload. */
const SHORT_MESSAGE = 160;

/**
 * What OpenRouter passes on of an upstream provider's error (`error.metadata`), in the few fields that
 * say why: the provider's name, its error type and code where given, and its own message only when it
 * is short, read from the provider's error (`raw`, its body: `error.message` or `message` of it as
 * JSON, or the text itself). Never the rest of the payload, which may be the provider's verbatim answer
 * (a content decline can quote the caller's words), and never a moderation's flagged input. Null when
 * there is nothing.
 */
function upstreamError(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const m = metadata as { provider_name?: unknown; error_type?: unknown; provider_code?: unknown; raw?: unknown };
  const word = (v: unknown): string | null => (typeof v === 'string' && WORD.test(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const provider = typeof m.provider_name === 'string' && /^[A-Za-z0-9 _.-]{1,40}$/.test(m.provider_name) ? m.provider_name : null;
  let said: string | null = null;
  if (typeof m.raw === 'string' && m.raw.trim() !== '') {
    let text: unknown = m.raw;
    try {
      const parsed = JSON.parse(m.raw) as { error?: { message?: unknown } | string; message?: unknown } | null;
      text = typeof parsed?.error === 'object' && parsed.error !== null ? parsed.error.message : typeof parsed?.error === 'string' ? parsed.error : parsed?.message;
    } catch {
      // Not JSON: the text itself.
    }
    if (typeof text === 'string') {
      const one = text.replace(/\s+/g, ' ').trim();
      if (one !== '' && one.length <= SHORT_MESSAGE) said = one;
    }
  }
  const codes = [word(m.error_type), word(m.provider_code)].filter((c): c is string => c !== null);
  const parts = [...codes, ...(said !== null ? [said] : [])].join(': ');
  if (provider === null && parts === '') return null;
  return provider === null ? parts : parts === '' ? provider : `${provider}: ${parts}`;
}

/**
 * An API's account of a failed request, made safe to record: one line, at most 200 characters, the key
 * masked (where one is given: an empty key masks nothing of its own), anything shaped like a key (`sk-...`, `key-...`) and any long unbroken token (24 characters or
 * more of letters, digits, `_` and `-`: another provider's key such as `AIza...`, a bearer token) masked.
 */
export function safeErrorText(t: string, key: string): string {
  return (key === '' ? t : t.split(key).join('•')).replace(/\b(sk|key)-[A-Za-z0-9_-]{8,}/g, '•').replace(/[A-Za-z0-9_-]{24,}/g, '•').replace(/\s+/g, ' ').trim().slice(0, 200);
}

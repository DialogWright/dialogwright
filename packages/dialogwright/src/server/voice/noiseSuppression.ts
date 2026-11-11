/**
 * Telnyx's noise suppression on a call (TELNYX_NOISE_SUPPRESSION), as its TeXML `<Suppression>` verb takes
 * it inside `<Start>` (developers.telnyx.com, "Noise suppression" and the TeXML `<Suppression>` reference):
 * `direction` (inbound, outbound or both, from Telnyx's side of the call: `outbound` is the audio Telnyx
 * receives from the caller, what speech recognition hears; `inbound` what it plays to them),
 * `noiseSuppressionEngine` (Denoiser, Telnyx's default; DeepFilterNet; Krisp; AiCoustics) and the
 * engine's own attributes: Krisp's `model` and `suppressionLevel`, AiCoustics' `family`, `size` and
 * `enhancementLevel`. TeXML documents none for Denoiser or DeepFilterNet (Call Control's
 * `attenuation_limit` and `mode`, and AiCoustics' `voice_gain`, are not TeXML attributes), so none is taken
 * for them. Telnyx bills it per direction, with no key of its own.
 *
 * The engine writes `direction="outbound"` only: the caller's audio, what the recognizer hears and what
 * a noisy room spoils (seen on a call made on speakerphone with a television on, 2026-11-10). It is a
 * Telnyx setting; no other carrier is sent it. Unset, nothing is written and the document is as before.
 */

/** The engines, as TeXML spells them. */
export const NOISE_SUPPRESSION_ENGINES = ['Denoiser', 'DeepFilterNet', 'Krisp', 'AiCoustics'] as const;
export type NoiseSuppressionEngine = (typeof NOISE_SUPPRESSION_ENGINES)[number];

/** Telnyx noise suppression as a start document writes it: the engine, and its own attributes in TeXML's names. */
export interface NoiseSuppression {
  readonly engine: NoiseSuppressionEngine;
  /** The engine's attributes (TELNYX_NOISE_SUPPRESSION_SETTINGS), in the order written; empty for the engine's defaults. */
  readonly settings: readonly (readonly [string, string])[];
}

/** The Krisp models Telnyx lists; another `.kef` name is taken too, should Telnyx add one. */
const KRISP_MODELS = ['krisp-viva-tel-v2.kef', 'krisp-viva-tel-lite-v1.kef', 'krisp-viva-pro-v1.kef', 'krisp-viva-ss-v1.kef'];

/** Whether `value` is a plain number from `min` to `max`. */
function inRange(value: string, min: number, max: number): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

/** Each engine's attributes, in the order they are written, with what a value must be. */
const SETTINGS: Readonly<Record<NoiseSuppressionEngine, readonly { name: string; valid: (v: string) => boolean; says: string }[]>> = {
  Denoiser: [],
  DeepFilterNet: [],
  Krisp: [
    { name: 'model', valid: (v) => /^[A-Za-z0-9._-]+\.kef$/.test(v), says: `a Krisp model file (${KRISP_MODELS.join(', ')})` },
    { name: 'suppressionLevel', valid: (v) => inRange(v, 0, 100), says: 'a number from 0 to 100' },
  ],
  AiCoustics: [
    { name: 'family', valid: (v) => v === 'sparrow' || v === 'quail', says: 'sparrow or quail' },
    { name: 'size', valid: (v) => v === 's' || v === 'l' || v === 'vf', says: 's, l or vf' },
    { name: 'enhancementLevel', valid: (v) => inRange(v, 0, 1), says: 'a number from 0 to 1' },
  ],
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * TELNYX_NOISE_SUPPRESSION (krisp, aicoustics, deepfilternet or denoiser, in any case) and
 * TELNYX_NOISE_SUPPRESSION_SETTINGS (the engine's TeXML attributes as `name=value` pairs, separated by
 * spaces or commas: `suppressionLevel=75 model=krisp-viva-tel-v2.kef`). Unset or empty: null, none. A
 * setting the engine does not take, a value it would not, settings with no engine, or an engine Telnyx does
 * not name are refused, so the server does not start with a document Telnyx might reject on every call.
 */
export function noiseSuppressionOf(env: Env): NoiseSuppression | null {
  const raw = env.TELNYX_NOISE_SUPPRESSION?.trim() ?? '';
  const settingsRaw = env.TELNYX_NOISE_SUPPRESSION_SETTINGS?.trim() ?? '';
  if (raw === '') {
    if (settingsRaw !== '') throw new Error('TELNYX_NOISE_SUPPRESSION_SETTINGS are an engine\'s: set TELNYX_NOISE_SUPPRESSION to krisp or aicoustics too, or unset TELNYX_NOISE_SUPPRESSION_SETTINGS');
    return null;
  }
  const engine = NOISE_SUPPRESSION_ENGINES.find((e) => e.toLowerCase() === raw.toLowerCase());
  if (engine === undefined) throw new Error(`TELNYX_NOISE_SUPPRESSION must be one of krisp, aicoustics, deepfilternet, denoiser, got "${raw}"`);
  const takes = SETTINGS[engine];
  const given = new Map<string, string>();
  for (const pair of settingsRaw.split(/[\s,]+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    const setting = takes.find((s) => s.name === name);
    if (setting === undefined) {
      const named = takes.length === 0 ? `${engine} takes none in TeXML` : `${engine} takes ${takes.map((s) => s.name).join(', ')}`;
      throw new Error(`TELNYX_NOISE_SUPPRESSION_SETTINGS names "${name}": ${named}`);
    }
    if (!setting.valid(value)) throw new Error(`TELNYX_NOISE_SUPPRESSION_SETTINGS ${name} must be ${setting.says}, got "${value}"`);
    given.set(name, value);
  }
  if (given.get('size') === 'vf' && given.get('family') !== 'quail') {
    throw new Error('TELNYX_NOISE_SUPPRESSION_SETTINGS size=vf needs family=quail (Telnyx\'s AiCoustics reference)');
  }
  return { engine, settings: takes.filter((s) => given.has(s.name)).map((s) => [s.name, given.get(s.name)!] as const) };
}

/** The `<Start><Suppression .../></Start>` a Telnyx start document opens with; empty for none. */
export function suppressionVerb(n: NoiseSuppression | null | undefined, attr: (name: string, value: string) => string): string {
  if (!n) return '';
  const attrs = [attr('direction', 'outbound'), attr('noiseSuppressionEngine', n.engine), ...n.settings.map(([name, value]) => attr(name, value))];
  return `<Start><Suppression ${attrs.join(' ')}/></Start>`;
}

/** The setting as the startup line and pnpm diagnose say it: `Krisp (suppressionLevel 75) on the caller's audio`. */
export function describeNoiseSuppression(n: NoiseSuppression): string {
  const settings = n.settings.length === 0 ? '' : ` (${n.settings.map(([name, value]) => `${name} ${value}`).join(', ')})`;
  return `${n.engine}${settings} on the caller's audio`;
}

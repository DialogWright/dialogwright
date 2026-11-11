import { describe, expect, it } from 'vitest';
import { describeNoiseSuppression, noiseSuppressionOf, suppressionVerb } from './noiseSuppression';
import { attr } from './xml';

describe('Telnyx noise suppression (TELNYX_NOISE_SUPPRESSION)', () => {
  it('is off unset or empty', () => {
    expect(noiseSuppressionOf({})).toBeNull();
    expect(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: ' ', TELNYX_NOISE_SUPPRESSION_SETTINGS: '' })).toBeNull();
    expect(suppressionVerb(null, attr)).toBe('');
  });

  it('takes each engine Telnyx names, in any case, spelled as TeXML spells it', () => {
    expect(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'krisp' })).toEqual({ engine: 'Krisp', settings: [] });
    expect(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: ' AICOUSTICS ' })).toEqual({ engine: 'AiCoustics', settings: [] });
    expect(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'deepfilternet' })).toEqual({ engine: 'DeepFilterNet', settings: [] });
    expect(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'Denoiser' })).toEqual({ engine: 'Denoiser', settings: [] });
    expect(() => noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'rnnoise' })).toThrow('TELNYX_NOISE_SUPPRESSION must be one of krisp, aicoustics, deepfilternet, denoiser, got "rnnoise"');
  });

  it('takes the engine\'s TeXML attributes, checked, written in a fixed order', () => {
    const krisp = noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'krisp', TELNYX_NOISE_SUPPRESSION_SETTINGS: 'suppressionLevel=75, model=krisp-viva-tel-v2.kef' });
    expect(krisp).toEqual({ engine: 'Krisp', settings: [['model', 'krisp-viva-tel-v2.kef'], ['suppressionLevel', '75']] });
    expect(suppressionVerb(krisp, attr)).toBe('<Start><Suppression direction="outbound" noiseSuppressionEngine="Krisp" model="krisp-viva-tel-v2.kef" suppressionLevel="75"/></Start>');
    expect(describeNoiseSuppression(krisp!)).toBe('Krisp (model krisp-viva-tel-v2.kef, suppressionLevel 75) on the caller\'s audio');
    const ai = noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'aicoustics', TELNYX_NOISE_SUPPRESSION_SETTINGS: 'enhancementLevel=0.6 size=vf family=quail' });
    expect(ai?.settings).toEqual([['family', 'quail'], ['size', 'vf'], ['enhancementLevel', '0.6']]);
    expect(describeNoiseSuppression(noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'denoiser' })!)).toBe('Denoiser on the caller\'s audio');
  });

  it('refuses a setting the engine does not take in TeXML, a value out of its range, and settings with no engine', () => {
    const krisp = { TELNYX_NOISE_SUPPRESSION: 'krisp' };
    expect(() => noiseSuppressionOf({ ...krisp, TELNYX_NOISE_SUPPRESSION_SETTINGS: 'suppressionLevel=101' })).toThrow('TELNYX_NOISE_SUPPRESSION_SETTINGS suppressionLevel must be a number from 0 to 100, got "101"');
    expect(() => noiseSuppressionOf({ ...krisp, TELNYX_NOISE_SUPPRESSION_SETTINGS: 'model=krisp"/>' })).toThrow(/model must be a Krisp model file/);
    expect(() => noiseSuppressionOf({ ...krisp, TELNYX_NOISE_SUPPRESSION_SETTINGS: 'enhancementLevel=0.5' })).toThrow('TELNYX_NOISE_SUPPRESSION_SETTINGS names "enhancementLevel": Krisp takes model, suppressionLevel');
    expect(() => noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'deepfilternet', TELNYX_NOISE_SUPPRESSION_SETTINGS: 'attenuation_limit=80' })).toThrow('TELNYX_NOISE_SUPPRESSION_SETTINGS names "attenuation_limit": DeepFilterNet takes none in TeXML');
    expect(() => noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'aicoustics', TELNYX_NOISE_SUPPRESSION_SETTINGS: 'enhancementLevel=2' })).toThrow(/enhancementLevel must be a number from 0 to 1/);
    expect(() => noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION: 'aicoustics', TELNYX_NOISE_SUPPRESSION_SETTINGS: 'size=vf' })).toThrow('size=vf needs family=quail');
    expect(() => noiseSuppressionOf({ TELNYX_NOISE_SUPPRESSION_SETTINGS: 'suppressionLevel=50' })).toThrow(/TELNYX_NOISE_SUPPRESSION_SETTINGS are an engine's/);
  });
});

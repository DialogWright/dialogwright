import { describe, expect, it } from 'vitest';
import { choice, noul, testSlotContext } from 'dialogwright';
import { otherProviderNamed, providerSlot } from './provider';

const ctx = testSlotContext('');

describe('providerSlot', () => {
  it('asks the roster choice, an unsure question, and whether the caller knows the name', () => {
    const q = providerSlot.questions(ctx);
    expect(q.provider?.type).toBe('choice');
    if (q.provider?.type === 'choice') expect(Object.keys(q.provider.criteria)).toEqual(['chen', 'cheng', 'patel', 'okafor', 'nguyen', 'rossi', 'kim', 'alvarez', 'none']);
    expect(q.providerUnsure?.type).toBe('noul');
    if (q.providerNameStatus?.type === 'choice') expect(Object.keys(q.providerNameStatus.criteria)).toEqual(['neither', 'has_name', 'no_name']);
  });

  it('fills silently above the fill band', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, cheng: 0.05, none: 0.04 }) }, ctx))
      .toEqual({ kind: 'filled', value: 'chen', display: 'Dr. Chen', confidence: 0.91, confirm: 'none' });
  });

  it('fills with an implicit readback in the confirm band', () => {
    // 0.47 is inside [SLOT_CHOICE_CONFIRM, SLOT_CHOICE_FILL); the mass is split three ways so none is not the top.
    expect(providerSlot.fill({ provider: choice({ patel: 0.47, none: 0.44, okafor: 0.09 }) }, ctx)).toMatchObject({ kind: 'filled', value: 'patel', confirm: 'implicit' });
  });

  it('asks which, for a narrow margin between two providers', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.48, cheng: 0.42, none: 0.1 }) }, ctx))
      .toEqual({ kind: 'disambiguate', a: { value: 'chen', display: 'Dr. Chen' }, b: { value: 'cheng', display: 'Dr. Cheng' } });
  });

  it('is absent when none wins or the top is below the confirm band', () => {
    expect(providerSlot.fill({ provider: choice({ none: 0.8, chen: 0.2 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.3, kim: 0.1, none: 0.6 }) }, ctx)).toEqual({ kind: 'absent' });
  });

  it('asks for the name, or reads the roster, when the caller says whether they know it', () => {
    const none = choice({ none: 0.9, chen: 0.1 });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.8, neither: 0.15, has_name: 0.05 }) }, ctx)).toEqual({ kind: 'help', promptId: 'provider_list' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ has_name: 0.7, neither: 0.2, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'help', promptId: 'ask_provider_name' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ no_name: 0.5, neither: 0.5 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none, providerNameStatus: choice({ neither: 0.9, no_name: 0.1 }) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: none }, ctx)).toEqual({ kind: 'absent' });
  });

  it('lets a named provider win over the status', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.9, none: 0.1 }), providerNameStatus: choice({ has_name: 0.9, neither: 0.1 }) }, ctx)).toMatchObject({ kind: 'filled', value: 'chen' });
  });

  it('parses a keypad digit in roster order', () => {
    expect(providerSlot.dtmf!.parse('3', ctx)).toEqual({ value: 'patel', display: 'Dr. Patel' });
    expect(providerSlot.dtmf!.parse('9', ctx)).toBeNull();
  });

  it('reads a hedged name back, however sure the model is', () => {
    expect(providerSlot.fill({ provider: choice({ kim: 0.98, none: 0.02 }), providerUnsure: noul(0.9) }, ctx)).toMatchObject({ kind: 'filled', value: 'kim', confirm: 'implicit' });
  });

  it('asks which for a narrow margin even when the caller hedges, and reads a clear winner back', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.5, cheng: 0.46, none: 0.04 }), providerUnsure: noul(0.9) }, ctx)).toMatchObject({ kind: 'disambiguate', a: { value: 'chen' }, b: { value: 'cheng' } });
    expect(providerSlot.fill({ provider: choice({ chen: 0.8, cheng: 0.15, none: 0.05 }), providerUnsure: noul(0.9) }, ctx)).toMatchObject({ kind: 'filled', value: 'chen', confirm: 'implicit' });
  });

  it('reads PROVIDER_UNSURE, at it counting as unsure, and an override in the run', () => {
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, none: 0.09 }), providerUnsure: noul(0.3) }, ctx)).toMatchObject({ confirm: 'none' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, none: 0.09 }), providerUnsure: noul(0.45) }, ctx)).toMatchObject({ confirm: 'implicit' });
    const strict = testSlotContext('', { thresholds: { ...ctx.thresholds, PROVIDER_UNSURE: 0.8 } });
    expect(providerSlot.fill({ provider: choice({ chen: 0.91, none: 0.09 }), providerUnsure: noul(0.5) }, strict)).toMatchObject({ confirm: 'none' });
  });

  it('stays absent when the caller hedges but no provider is named well enough', () => {
    expect(providerSlot.fill({ provider: choice({ none: 0.8, chen: 0.2 }), providerUnsure: noul(0.9) }, ctx)).toEqual({ kind: 'absent' });
    expect(providerSlot.fill({ provider: choice({ chen: 0.3, none: 0.6 }), providerUnsure: noul(0.9) }, ctx)).toEqual({ kind: 'absent' });
  });

  // The recorded model's answers to the fixtures' two-name texts: the hedges put providerUnsure at
  // 0.96-0.97 and nearly all the provider weight on Chen; the corrections stay sure (0.12, 0.19).
  describe('a hedge between two names the words both say', () => {
    const recordedHedge = { provider: choice({ chen: 0.73, none: 0.18, cheng: 0.09 }), providerUnsure: noul(0.97) };

    it('asks which of the two, though the model put its weight on one', () => {
      expect(providerSlot.fill(recordedHedge, testSlotContext("either Dr. Chen or Dr. Cheng, I'm not sure which")))
        .toEqual({ kind: 'disambiguate', a: { value: 'chen', display: 'Dr. Chen' }, b: { value: 'cheng', display: 'Dr. Cheng' } });
      expect(providerSlot.fill({ provider: choice({ chen: 0.86, none: 0.08, cheng: 0.06 }), providerUnsure: noul(0.96) }, testSlotContext("I'm seeing Dr. Chen, or Cheng, I'm not sure")))
        .toMatchObject({ kind: 'disambiguate', a: { value: 'chen' }, b: { value: 'cheng' } });
      // The second name is any on the roster, and the one the words say first when they say more.
      expect(providerSlot.fill({ provider: choice({ kim: 0.9, none: 0.1 }), providerUnsure: noul(0.9) }, testSlotContext('Dr. Kim or maybe Dr. Rossi, or Patel')))
        .toMatchObject({ kind: 'disambiguate', a: { value: 'kim' }, b: { value: 'rossi' } });
    });

    it('leaves a correction alone: it is not unsure, so the name it lands on fills', () => {
      expect(providerSlot.fill({ provider: choice({ cheng: 0.67, none: 0.3, patel: 0.03 }), providerUnsure: noul(0.12) }, testSlotContext('Cheng, not Chen')))
        .toMatchObject({ kind: 'filled', value: 'cheng' });
      expect(providerSlot.fill({ provider: choice({ cheng: 0.96, none: 0.03, patel: 0.01 }), providerUnsure: noul(0.19) }, testSlotContext('not Chen, Cheng')))
        .toMatchObject({ kind: 'filled', value: 'cheng', confirm: 'none' });
    });

    it('reads a hedged single name back, as before', () => {
      expect(providerSlot.fill({ provider: choice({ kim: 0.98, none: 0.02 }), providerUnsure: noul(0.9) }, testSlotContext('it might be Dr. Kim')))
        .toMatchObject({ kind: 'filled', value: 'kim', confirm: 'implicit' });
    });

    it('matches a whole word only: Chen is not inside Cheng, nor Cheng inside Chen', () => {
      expect(otherProviderNamed('Dr. Cheng, I think', 'cheng')).toBeNull();
      expect(otherProviderNamed('Dr. Chen, I think', 'chen')).toBeNull();
      expect(otherProviderNamed('Dr. Cheng or Chen', 'cheng')).toBe('chen');
      expect(otherProviderNamed('kimberly said', 'chen')).toBeNull();
    });
  });
});

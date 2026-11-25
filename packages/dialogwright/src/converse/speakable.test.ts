import { describe, expect, it } from 'vitest';
import { forTheEar, speakableOn } from './speakable';

/**
 * The words sent to the voice on a converse app's call (speakable.ts), with the frames of the first live calls
 * (2026-11-25) as cases, and what must be left as it is.
 */

const ear = (text: string): string => forTheEar(text, { callerLastFour: '9110' });

describe('forTheEar: a range said as one', () => {
  it('a range of amounts joined by an en dash (the live frame): "<a> to <b>"', () => {
    expect(ear("For curb rash — scrapes and gouges on the rim's edge from a curb — it's $125–$175 per wheel. ")).toBe(
      "For curb rash — scrapes and gouges on the rim's edge from a curb — it's $125 to $175 per wheel. ",
    );
    expect(ear('That one is $175–$250.')).toBe('That one is $175 to $250.');
  });

  it('an en or em dash between numbers, with or without spaces, amounts or not', () => {
    expect(ear('It takes 2–3 days.')).toBe('It takes 2 to 3 days.');
    expect(ear('About $60 – $120 a visit.')).toBe('About $60 to $120 a visit.');
    expect(ear('Open 9—5.')).toBe('Open 9 to 5.');
    expect(ear('From 10:00–11:30.')).toBe('From 10:00 to 11:30.');
    expect(ear('$1,200–$1,500 in all.')).toBe('$1,200 to $1,500 in all.');
    expect(ear('A 10%–15% discount.')).toBe('A 10% to 15% discount.');
  });

  it('a hyphen only where a $ or a % marks the numbers as amounts', () => {
    expect(ear('It is $125-$175.')).toBe('It is $125 to $175.');
    expect(ear('It is $125-175.')).toBe('It is $125 to 175.');
    expect(ear('About 10-20% off.')).toBe('About 10 to 20% off.');
    // A date, a phone number, a plain hyphenated word and a count with a hyphen are left as they are.
    expect(ear('On 2026-11-25 at 10:42.')).toBe('On 2026-11-25 at 10:42.');
    expect(ear('Call 555-0101 or 555-555-0101.')).toBe('Call 555-0101 or 555-555-0101.');
    expect(ear('A well-known, drop-off service, open 9-5.')).toBe('A well-known, drop-off service, open 9-5.');
  });

  it('a dash between words, or a number and a word, stays a dash', () => {
    expect(ear('We have 2 windows — morning and afternoon.')).toBe('We have 2 windows — morning and afternoon.');
    expect(ear('Drop off by 8 — ready by noon.')).toBe('Drop off by 8 — ready by noon.');
  });
});

describe("forTheEar: the caller's last four, digit by digit", () => {
  it('said digit by digit wherever they stand whole (the live frames)', () => {
    expect(ear("And can I text you at the number you're calling from, ending in 9110, or would you rather we call instead?")).toBe(
      "And can I text you at the number you're calling from, ending in 9 1 1 0, or would you rather we call instead?",
    );
    expect(ear("We'll reach you on ...9110, is that right?")).toBe("We'll reach you on ...9 1 1 0, is that right?");
  });

  it('never inside a longer number, a date, a time or an amount', () => {
    expect(ear('Ticket 49110 is open.')).toBe('Ticket 49110 is open.');
    expect(ear('Ticket 91105 is open.')).toBe('Ticket 91105 is open.');
    expect(ear('It was $9110.50.')).toBe('It was $9110.50.');
    expect(ear('Call 555-9110.')).toBe('Call 555-9110.');
  });

  it('a year, a time and a phone number written whole are left alone where they are not the last four', () => {
    expect(forTheEar('In 2026, at 10:42, call 555 555 0101.', { callerLastFour: '0123' })).toBe('In 2026, at 10:42, call 555 555 0101.');
  });

  it('nothing is spelled with no caller number', () => {
    expect(forTheEar('ending in 9110', {})).toBe('ending in 9110');
  });
});

describe('forTheEar: a screen list said as speech', () => {
  it('a bulleted list (the live frame): its items one after another, a comma between them', () => {
    expect(ear('To get you priced, could you tell me:\n- your name\n- what car it is\n- how many wheels are affected\n- what the wheel face looks like — scuffed or bent?\n\n')).toBe(
      'To get you priced, could you tell me: your name, what car it is, how many wheels are affected, what the wheel face looks like — scuffed or bent? ',
    );
  });

  it('a list between sentences, with blank lines (the live frame)', () => {
    expect(ear("For Tuesday, December 1, we've got two windows:\n\n- Morning: drop off by 8, ready by about noon\n- Afternoon: drop off by 1, ready by about 5\n\nWhich would you prefer?\n\n")).toBe(
      "For Tuesday, December 1, we've got two windows: Morning: drop off by 8, ready by about noon, Afternoon: drop off by 1, ready by about 5, Which would you prefer? ",
    );
  });

  it('numbered and starred markers, and the sentence\'s own punctuation kept', () => {
    expect(ear('Two things:\n1. your name.\n2) your day.')).toBe('Two things: your name. your day.');
    expect(ear('* one\n* two')).toBe('one, two');
  });

  it('a list cut into sentences as it streams: each piece said as its part of the list', () => {
    // The sentence buffer ends a piece after "1." of the next item's marker: the marker is dropped, the item before it gets its comma.
    expect(ear('could you tell me:\n1. ')).toBe('could you tell me: ');
    expect(ear('your name\n2. ')).toBe('your name, ');
    expect(ear('your day?')).toBe('your day?');
  });

  it('a heading and markdown emphasis never reach the voice', () => {
    expect(ear('## Prices\nIt is **$60** a visit.')).toBe('Prices, It is $60 a visit.');
  });

  it('a hyphen inside a line, or a number at a line\'s start, is no marker', () => {
    expect(ear('A drop-off - then pick-up.')).toBe('A drop-off - then pick-up.');
    expect(ear('We open at\n9 tomorrow.')).toBe('We open at, 9 tomorrow.');
  });
});

describe('forTheEar: as a whole', () => {
  it('plain text is unchanged, its spacing kept', () => {
    for (const t of ['Sure, we can help. ', 'What day suits you?', 'One sec.', "It's 9 to 12, Monday.", '']) expect(ear(t)).toBe(t);
  });

  it('said again, it changes nothing more', () => {
    for (const t of [
      "it's $125–$175 per wheel. ",
      'ending in 9110, ',
      'could you tell me:\n- your name\n- your car\n\n',
      '## Head\n**bold** 10-20% off',
    ]) expect(ear(ear(t))).toBe(ear(t));
  });
});

describe('speakableOn', () => {
  it('a call has its words made speakable, by the caller\'s number; a chat keeps them as written', () => {
    const voice = { channel: 'voice' as const, caller: { number: '+15555559110' } };
    const chat = { channel: 'chat' as const, caller: { number: '+15555559110' } };
    expect(speakableOn(voice, 'ending in 9110, $125–$175')).toBe('ending in 9 1 1 0, $125 to $175');
    expect(speakableOn(chat, 'ending in 9110, $125–$175')).toBe('ending in 9110, $125–$175');
    expect(speakableOn({ channel: 'voice', caller: {} }, 'ending in 9110')).toBe('ending in 9110');
  });
});

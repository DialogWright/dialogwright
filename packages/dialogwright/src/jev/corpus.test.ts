import { describe, expect, it } from 'vitest';
import { confirmForm, contextForm, loadCorpus, normalizeText, offerTransfer, parseCorpus, type CorpusEntry } from './corpus';
import { useTestkit } from '../testing/apps';
import { testkitApp } from '../testing/testkit';
import type { TestkitCorpusSlots } from '../testing/testkit/domain/testing';
import { FORM_INTENTS } from '../testing/testkit/domain/intents';
import { SLOTS } from '../testing/testkit/domain/slots';
import { candidateSpans } from '../core/spans';
import { spokenToDigits } from '../core/extract/spokenNumber';
import { ALWAYS_ON_IDS } from '../core/questions';
import { DEFAULT_THRESHOLDS } from '../core/thresholds';
import type { SlotContext } from '../core/slots/types';

useTestkit();

/** The testkit's corpus labels on an entry (CorpusEntry.slots is the app's own shape). */
const slotsOf = (e: CorpusEntry | undefined): TestkitCorpusSlots | undefined => e?.slots as TestkitCorpusSlots | undefined;

const corpus = loadCorpus('src/testing/testkit/fixtures/corpus.jsonl');

describe('the testkit corpus (the mechanics every app\'s corpus is held to)', () => {
  it('uses valid contexts', () => {
    for (const e of corpus) {
      expect(['no_form', 'anything_else'].includes(e.context) || contextForm(e.context) !== null, `${e.id}: ${e.context}`).toBe(true);
      // A prompted slot needs a question the caller is on: a form in progress, or the offer made
      // during one.
      if (e.prompted) expect([...FORM_INTENTS, 'offer_transfer'], e.id).toContain(e.context);
    }
  });

  it('overrides name only questions the schema can ask', () => {
    const ctx: SlotContext = {
      text: '7101', candidateSpans: [], candidateWordSpans: [], todayIso: '2026-09-18', thresholds: DEFAULT_THRESHOLDS,
      window: null, current: null, records: [], prompted: false,
    };
    const askable = new Set<string>([...ALWAYS_ON_IDS, 'confirmsYes', 'confirmsNo', 'menuNumberSaid', 'intentChange', 'changeSlot', 'secondIntent', 'manipulation']);
    for (const spec of Object.values(SLOTS)) for (const id of Object.keys(spec.questions({ ...ctx, text: 'where is parcel 7101' }))) askable.add(id);
    for (const e of corpus) {
      for (const id of Object.keys(e.answers ?? {})) expect([...askable], `${e.id}: ${id}`).toContain(id);
    }
  });

  it('reads like speech recognition: no punctuation beyond apostrophes and commas', () => {
    for (const e of corpus) expect(e.text, e.id).toMatch(/^[a-z0-9 ',-]+$/);
  });

  it('labels account id spans that exist as candidate spans and normalize to the value', () => {
    const labelled = corpus.filter((e) => slotsOf(e)?.accountId);
    expect(labelled.length).toBeGreaterThan(0);
    for (const e of labelled) {
      const a = slotsOf(e)!.accountId!;
      expect(candidateSpans(e.text), e.id).toContain(normalizeText(a.span));
      expect(spokenToDigits(a.span), e.id).toBe(a.value);
    }
  });

  it('labels only parcels the words can mean, as four digits', () => {
    for (const e of corpus) {
      const n = slotsOf(e)?.parcelSelect;
      if (n !== undefined) expect(n, e.id).toMatch(/^\d{4}$/);
    }
  });

  it('covers every form intent and every slot of the app', () => {
    const intents = new Set(corpus.map((e) => e.intent));
    for (const i of FORM_INTENTS) expect(intents, i).toContain(i);
    const labelled = new Set(corpus.flatMap((e) => Object.keys(e.slots ?? {})));
    for (const slot of Object.keys(testkitApp.slots)) expect(labelled, slot).toContain(slot);
  });
});

describe('parseCorpus', () => {
  const entries: CorpusEntry[] = [
    {
      id: 'r1', text: 'my parcel never arrived, a small brown box left at the side gate on Saturday', intent: 'report_missing', context: 'no_form',
      slots: { missingNote: true, expectedDate: { mode: 'weekday', weekday: 'saturday' } },
    },
    {
      id: 'm1', text: 'five five five zero one two three four', intent: 'none', context: 'track_parcel', prompted: 'accountId',
      slots: { accountId: { span: 'five five five zero one two three four', value: '55501234' } },
    },
  ];
  const one = (fields: string) => `{"id":"x","text":"x","intent":"none",${fields}}`;

  it('parses JSONL, skips blank lines and rejects duplicate ids', () => {
    const text = JSON.stringify(entries[0]) + '\n\n' + JSON.stringify(entries[1]) + '\n';
    expect(parseCorpus(text).map((e) => e.id)).toEqual(['r1', 'm1']);
    expect(() => parseCorpus(text + JSON.stringify(entries[0]))).toThrow(/duplicate/);
  });

  it('takes knownGap as a reason and the outcome fields it pins, and rejects anything else', () => {
    const line = (gap: unknown) => `${JSON.stringify({ id: 'k', text: 'x', intent: 'none', context: 'no_form', knownGap: gap })}\n`;
    const ok = parseCorpus(line({ reason: 'the model reads it as a name', outcome: { promptId: 'ask_name', acks: ['ack_intent'] } }));
    expect(ok[0]?.knownGap).toEqual({ reason: 'the model reads it as a name', outcome: { promptId: 'ask_name', acks: ['ack_intent'] } });
    // The old form, a bare reason, pins nothing, so it is refused.
    expect(() => parseCorpus(line('the model reads it as a name'))).toThrow(/knownGap must be \{ reason, outcome \}/);
    expect(() => parseCorpus(line({ reason: '', outcome: { promptId: 'a' } }))).toThrow(/the reason is missing/);
    expect(() => parseCorpus(line({ reason: 'r' }))).toThrow(/the outcome pins no field/);
    expect(() => parseCorpus(line({ reason: 'r', outcome: {} }))).toThrow(/the outcome pins no field/);
    expect(() => parseCorpus(line({ reason: 'r', outcome: { id: 'k' } }))).toThrow(/knownGap.outcome pins id, which is not an outcome field/);
    expect(() => parseCorpus(line({ reason: 'r', outcome: { promptId: 'a' }, why: 'x' }))).toThrow(/unknown key why/);
  });

  it('normalizes text for lookup', () => {
    expect(normalizeText("What's the status, of my parcel?")).toBe('what s the status of my parcel');
  });

  it('rejects an unknown context and duplicate normalized text', () => {
    const badContext = { ...entries[0], context: 'not_a_form' };
    expect(() => parseCorpus(JSON.stringify(badContext))).toThrow(/unknown context/);
    const dup = { ...entries[0], id: 'r1-dup', text: 'My parcel never arrived! A small brown box left at the side gate on Saturday.' };
    expect(() => parseCorpus(JSON.stringify(entries[0]) + '\n' + JSON.stringify(dup))).toThrow(/duplicates/);
  });

  it('accepts tentative, change and manipulation labels and rejects bad ones', () => {
    const ok = parseCorpus('{"id":"a","text":"maybe","intent":"report_missing","context":"no_form","tentative":true,"manipulation":true}\n{"id":"b","text":"also my parcel","intent":"track_parcel","context":"report_missing","change":"adding"}\n');
    expect(ok[0]?.tentative).toBe(true);
    expect(ok[0]?.manipulation).toBe(true);
    expect(ok[1]?.change).toBe('adding');
    expect(() => parseCorpus('{"id":"c","text":"x","intent":"track_parcel","context":"report_missing","change":"swapping"}\n')).toThrow(/must be adding or replacing/);
    expect(() => parseCorpus('{"id":"d","text":"x","intent":"track_parcel","context":"no_form","change":"adding"}\n')).toThrow(/needs a form context/);
    expect(() => parseCorpus('{"id":"d2","text":"x","intent":"track_parcel","context":"anything_else","change":"adding"}\n')).toThrow(/needs a form context/);
    expect(() => parseCorpus('{"id":"e","text":"x","intent":"track_parcel","context":"no_form","tentaive":true}\n')).toThrow(/unknown field tentaive/);
    expect(() => parseCorpus('{"id":"f","text":"x","intent":"track_parcel","context":"no_form","tentative":"true"}\n')).toThrow(/must be a boolean/);
    expect(() => parseCorpus('{"id":"f2","text":"x","intent":"track_parcel","context":"no_form","manipulation":"yes"}\n')).toThrow(/manipulation must be a boolean/);
    expect(() => parseCorpus('{"id":"g","text":"x","intent":"none","context":"report_missing","change":"adding"}\n')).toThrow(/needs an intent/);
  });

  it('takes as, a depot agent typing in the chat, only as known staff and only with no form open', () => {
    expect(parseCorpus('{"id":"b1","text":"status of parcel 7101","intent":"track_parcel","context":"no_form","as":"taylor"}\n')[0]?.as).toBe('taylor');
    expect(() => parseCorpus('{"id":"b2","text":"x","intent":"track_parcel","context":"no_form","as":"mallory"}\n')).toThrow(/is not a agent/);
    expect(() => parseCorpus('{"id":"b3","text":"x","intent":"none","context":"track_parcel","as":"taylor"}\n')).toThrow(/as needs the no_form context/);
  });

  it('takes prompted as a slot on the form, or an identity factor in any form context', () => {
    expect(parseCorpus(one('"context":"delivery_window","prompted":"deliveryPart"'))[0]?.prompted).toBe('deliveryPart');
    expect(parseCorpus(one('"context":"delivery_window","prompted":"dob"'))[0]?.prompted).toBe('dob');
    expect(parseCorpus(one('"context":"report_missing","prompted":"accountId"'))[0]?.prompted).toBe('accountId');
    expect(() => parseCorpus(one('"context":"delivery_window","prompted":"expectedDate"'))).toThrow(/not on form delivery_window/);
    expect(() => parseCorpus(one('"context":"no_form","prompted":"accountId"'))).toThrow(/needs a form context/);
    expect(() => parseCorpus(one('"context":"anything_else","prompted":"deliveryPart"'))).toThrow(/needs a form context/);
    expect(() => parseCorpus(one('"context":"confirm_report_missing","prompted":"expectedDate"'))).toThrow(/needs a form context/);
  });

  it('takes the identity slots only where a step-up asks for them, and a switched-to form\'s slots on a switch', () => {
    const id = '"slots":{"accountId":{"span":"55501234","value":"55501234"}}';
    expect(() => parseCorpus('{"id":"x","text":"55501234","intent":"none","context":"delivery_window",' + id + '}')).toThrow(/slot accountId is not on form delivery_window/);
    expect(slotsOf(parseCorpus('{"id":"x","text":"55501234","intent":"none","context":"delivery_window","prompted":"accountId",' + id + '}')[0])?.accountId?.value).toBe('55501234');
    expect(parseCorpus('{"id":"x","text":"55501234","intent":"none","context":"no_form",' + id + '}')).toHaveLength(1);
    const part = '"slots":{"deliveryPart":"morning"}';
    expect(() => parseCorpus('{"id":"y","text":"in the morning","intent":"delivery_window","context":"report_missing",' + part + '}')).toThrow(/not on form report_missing/);
    expect(parseCorpus('{"id":"y","text":"in the morning","intent":"delivery_window","context":"report_missing","change":"replacing",' + part + '}')).toHaveLength(1);
    expect(parseCorpus('{"id":"y","text":"in the morning","intent":"delivery_window","context":"report_missing","change":"adding",' + part + '}')).toHaveLength(1);
  });

  it('checks each slot label against what its question can offer', () => {
    const slot = (text: string, slots: string) => parseCorpus(`{"id":"s","text":"${text}","intent":"none","context":"no_form","slots":${slots}}`);
    expect(() => slot('five five five zero', '{"accountId":{"span":"nine nine","value":"99"}}')).toThrow(/not a candidate span/);
    expect(() => slot('five five five zero one two three four', '{"accountId":{"span":"five five five zero one two three four","value":"55501235"}}')).toThrow(/is not the span's digits/);
    expect(() => slot('parcel 71', '{"parcelSelect":"71"}')).toThrow(/not four digits/);
    expect(() => slot('at midnight', '{"deliveryPart":"midnight"}')).toThrow(/not a part of the day/);
    expect(() => slot('this saturday', '{"deliveryDay":{"mode":"window","weekday":"saturday"}}')).toThrow(/deliveryDay mode "window"/);
    expect(() => slot('this caturday', '{"deliveryDay":{"mode":"weekday","weekday":"caturday"}}')).toThrow(/deliveryDay weekday "caturday"/);
    expect(() => slot('next week', '{"deliveryDay":{"mode":"weekday"}}')).toThrow(/mode weekday needs weekday/);
    expect(() => slot('on the twelfth', '{"deliveryDay":{"mode":"absolute","month":"sept","day":"12"}}')).toThrow(/deliveryDay month "sept"/);
    expect(() => slot('it was a small box', '{"missingNote":"yes"}')).toThrow(/missingNote must be a boolean/);
    expect(() => slot('it was a small box', '{"name":"alex"}')).toThrow(/unknown slot name/);
  });

  it('leaves the slot labels to the app: one with no testing hooks checks only that each names its slot', () => {
    const bare = { ...testkitApp, testing: undefined };
    const slot = (slots: string) => parseCorpus(`{"id":"s","text":"at midnight","intent":"none","context":"no_form","slots":${slots}}`, bare);
    expect(slotsOf(slot('{"deliveryPart":"midnight"}')[0])?.deliveryPart).toBe('midnight');
    expect(() => slot('{"name":"alex"}')).toThrow(/unknown slot name/);
  });

  it('takes as only for staff the app can sign in', () => {
    const line = '{"id":"b1","text":"status of parcel 7101","intent":"track_parcel","context":"no_form","as":"taylor"}\n';
    expect(() => parseCorpus(line, { ...testkitApp, principals: undefined })).toThrow(/is not a agent/);
  });

  it('accepts confirm contexts with confirm, changeSlot, and slot labels, and secondIntent outside a form', () => {
    const [a, b, c, d] = parseCorpus([
      '{"id":"fc-1","text":"yes","intent":"none","context":"confirm_report_missing","confirm":"yes"}',
      '{"id":"fc-2","text":"no the date","intent":"none","context":"confirm_report_missing","confirm":"no","changeSlot":"expectedDate"}',
      '{"id":"fc-3","text":"where is my parcel and when can you deliver","intent":"track_parcel","context":"no_form","secondIntent":"delivery_window"}',
      '{"id":"fc-4","text":"and where is my parcel and when can you deliver","intent":"track_parcel","context":"anything_else","secondIntent":"delivery_window"}',
    ].join('\n'));
    expect(a?.confirm).toBe('yes');
    expect(b?.changeSlot).toBe('expectedDate');
    expect(c?.secondIntent).toBe('delivery_window');
    expect(d?.secondIntent).toBe('delivery_window');
  });

  it('rejects confirm labels off a confirm context, changeSlot for a slot not on the form, and secondIntent in a form', () => {
    expect(() => parseCorpus('{"id":"x","text":"yes","intent":"none","context":"report_missing","confirm":"yes"}')).toThrow(/confirm needs a confirm_ or offer_transfer context/);
    expect(() => parseCorpus('{"id":"x","text":"the parcel","intent":"none","context":"confirm_report_missing","changeSlot":"parcelSelect"}')).toThrow(/not on form report_missing/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"track_parcel","context":"track_parcel","secondIntent":"delivery_window"}')).toThrow(/secondIntent needs no_form or anything_else/);
    expect(() => parseCorpus('{"id":"x","text":"x","intent":"none","context":"confirm_track_parcel"}')).toThrow(/unknown context/);
  });

  it('rejects a changeSlot alongside confirm yes, and a secondIntent equal to intent', () => {
    expect(() => parseCorpus('{"id":"x","text":"yes the date","intent":"none","context":"confirm_report_missing","confirm":"yes","changeSlot":"expectedDate"}')).toThrow(/changeSlot needs confirm no or unanswered/);
    expect(() => parseCorpus('{"id":"x","text":"my parcel and my parcel","intent":"track_parcel","context":"no_form","secondIntent":"track_parcel"}')).toThrow(/secondIntent must differ from intent/);
  });

  it('rejects a birth year span that the text does not offer as a candidate', () => {
    const born = (slots: string) => `{"id":"y","text":"April twelfth nineteen eighty five","intent":"none","context":"no_form","slots":${slots}}`;
    expect(slotsOf(parseCorpus(born('{"dob":{"month":"april","day":"12","year":"nineteen eighty five"}}'))[0])?.dob?.day).toBe('12');
    expect(() => parseCorpus(born('{"dob":{"month":"april","day":"12","year":"nineteen ninety"}}'))).toThrow(/not a candidate span/);
    expect(() => parseCorpus(born('{"dob":{"month":"april"}}'))).toThrow(/month and day together/);
    expect(slotsOf(parseCorpus(born('{"dob":{"year":"nineteen eighty five"}}'))[0])?.dob?.year).toBe('nineteen eighty five');
  });

  it('rejects a dob month or day the slot\'s own choice labels do not offer', () => {
    // "Apr" and "31st" would parse clean and then pick `none` at run time, so the labelled
    // birthday would silently never be read. The month and day are choice labels, not spans.
    const born = (slots: string) => `{"id":"z","text":"April thirty first nineteen eighty five","intent":"none","context":"no_form","slots":${slots}}`;
    expect(slotsOf(parseCorpus(born('{"dob":{"month":"april","day":"31"}}'))[0])?.dob?.month).toBe('april');
    expect(() => parseCorpus(born('{"dob":{"month":"Apr","day":"31"}}'))).toThrow(/corpus z: dob month "Apr"/);
    expect(() => parseCorpus(born('{"dob":{"month":"april","day":"31st"}}'))).toThrow(/corpus z: dob day "31st"/);
    expect(() => parseCorpus(born('{"dob":{"month":"april","day":"32"}}'))).toThrow(/corpus z: dob day "32"/);
  });

  it('resolves confirm_report_missing to its form, and the forms without a summary to no confirm context', () => {
    expect(confirmForm('confirm_report_missing')).toBe('report_missing');
    expect(contextForm('confirm_report_missing')).toBe('report_missing');
    expect(contextForm('confirm_track_parcel')).toBeNull();
    expect(contextForm('confirm_delivery_window')).toBeNull();
  });

  it('resolves anything_else to no form, and it is no confirm context', () => {
    expect(contextForm('anything_else')).toBeNull();
    expect(confirmForm('anything_else')).toBeNull();
    expect(offerTransfer('anything_else')).toBe(false);
  });

  it('resolves offer_transfer to the form the offer is made inside, without being a confirm_ context', () => {
    expect(contextForm('offer_transfer')).toBe('track_parcel');
    expect(confirmForm('offer_transfer')).toBeNull();
    expect(offerTransfer('offer_transfer')).toBe(true);
    expect(offerTransfer('confirm_report_missing')).toBe(false);
  });
});

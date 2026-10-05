import { describe, expect, it } from 'vitest';
import { consoleMetaOf, renderConsolePage } from './meta';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONSOLE_ELEMENT_IDS } from '../../core/app/validate';
import { testkitApp } from '../../testing/testkit';
import type { App } from '../../core/app/types';
import { ALL_SLOTS, serviceNoteView, configure, formLabel, handoffReasonText } from './view.js';

/** The testkit with none of its console words: what the console makes of an app that gives it nothing. */
const bare: App = { ...testkitApp, id: 'acme', brand: undefined, console: undefined };

describe('consoleMetaOf', () => {
  it('fills in neutral words, and reads slots, forms and identity off the app itself', () => {
    const m = consoleMetaOf(bare);
    expect(m.brand).toEqual({ name: 'acme', mark: 'AC', key: 'acme' });
    expect(m.formSlots).toEqual(Object.fromEntries(Object.entries(testkitApp.forms).map(([id, f]) => [id, [...f.slots]])));
    // The identity factors, then each form's slots in turn, each once.
    expect(m.slotOrder).toEqual(['accountId', 'dob', 'parcelSelect', 'deliveryDay', 'deliveryPart', 'missingNote', 'expectedDate']);
    expect(m.stepUp).toEqual(['accountId', 'dob']);
    // From each slot spec: an ID redacted to its last four, a verified factor, words redacted to their length.
    expect(m.chipStyle).toEqual({ accountId: 'last4', dob: 'verified', missingNote: 'recorded' });
    expect(m).toMatchObject({
      formLabels: {}, slotLabels: {}, questionPrefixes: {}, detectQuestions: [], levels: ['anonymous', 'verified', 'confirmed by code'],
      handoffReasons: {}, facts: [], goodAuditTypes: [], serviceNote: { label: 'Downstream service', answered: 'answered' },
      signIn: { marker: 'signed in · portal', role: null }, chatPrefixes: [], heardBy: 'the caller', links: [],
    });
  });
});

describe('consoleMetaOf: a slot shown as said', () => {
  it('shows a slot whose display is the words as said by its written value (SlotSpec.displayFrom)', () => {
    const note = testkitApp.slots.missingNote!;
    const said: App = { ...bare, slots: { ...bare.slots, missingNote: { ...note, redact: undefined, displayFrom: 'said' } } };
    expect(consoleMetaOf(said).chipStyle).toEqual({ accountId: 'last4', dob: 'verified', missingNote: 'value' });
  });
});

describe('consoleMetaOf: the level badge', () => {
  it('names each level as identity.yaml does where the console gives no words, and neutrally where neither does', () => {
    // The testkit's identity.yaml calls level 1 "verified" and level 2 "confirmed by code" (bare above).
    expect(consoleMetaOf(bare).levels).toEqual(['anonymous', 'verified', 'confirmed by code']);
    expect(consoleMetaOf({ ...bare, identity: { ...bare.identity!, levelNames: { 1: 'matched' } } }).levels).toEqual(['anonymous', 'matched', 'level 2']);
    const { identity: _, ...noIdentity } = bare;
    expect(consoleMetaOf(noIdentity as App).levels).toEqual(['anonymous', 'level 1', 'level 2']);
    // The console's own words win: the testkit's app.yaml-style words.
    expect(consoleMetaOf(testkitApp).levels).toEqual(['anonymous', 'ID + DOB', '+ code']);
  });
});

describe('renderConsolePage', () => {
  it('puts in the brand escaped, one header button per link, and the metadata as a script literal that cannot close its script', () => {
    const meta = { ...consoleMetaOf(bare), brand: { name: 'A&B <Co>', mark: '$&', key: 'ab' } };
    meta.links = [{ id: 'x', label: 'Open "x"', title: "x's page", href: '/x', target: 'ab-x', features: 'width=1' }];
    const page = renderConsolePage('<title>{{name}}</title><b>{{mark}}</b>\n{{links}}<script>const APP = {{meta}};</script>', meta);
    expect(page).toContain('<title>A&amp;B &lt;Co&gt;</title><b>$&amp;</b>\n    <button id="x" title="x&#39;s page">Open &quot;x&quot;</button>\n<script>');
    const literal = /const APP = (.*);<\/script>/.exec(page)![1]!;
    expect(literal).not.toContain('</');
    expect(JSON.parse(literal)).toEqual(meta);
  });

  it('puts every value in in one pass, so a brand that spells a placeholder breaks nothing', () => {
    const meta = { ...consoleMetaOf(bare), brand: { name: '{{meta}}', mark: '{{links}}', key: 'k' } };
    const page = renderConsolePage('<title>{{name}}</title><b>{{mark}}</b>{{links}}<script>const APP = {{meta}};</script>', meta);
    expect(page).toContain('<title>{{meta}}</title><b>{{links}}</b>');
    const literal = /const APP = (.*);<\/script>/.exec(page)![1]!;
    expect(JSON.parse(literal)).toEqual(meta);
    // Every placeholder is replaced, wherever it stands, and none is left over.
    expect(renderConsolePage('{{name}}{{name}}{{unknown}}', consoleMetaOf(bare))).toBe('acmeacme{{unknown}}');
  });
});

describe('the element ids a console link may not take', () => {
  it('are exactly the ids the console page uses', () => {
    const page = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'page.html'), 'utf8');
    const used = new Set([...page.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g), ...page.matchAll(/\bel\('([a-zA-Z0-9_-]+)'\)/g)].map((m) => m[1]!));
    expect([...used].sort()).toEqual([...CONSOLE_ELEMENT_IDS].sort());
  });
});

describe('view.js on an app with no console words', () => {
  it('reads forms, reasons and agent answers in neutral words', () => {
    configure(consoleMetaOf(bare));
    expect(ALL_SLOTS).toEqual(consoleMetaOf(bare).slotOrder);
    expect(formLabel('report_missing')).toBe('report missing');
    expect(handoffReasonText('live-agent')).toBe('caller asked for a person');
    expect(handoffReasonText('role-person')).toBe('role person');
    expect(serviceNoteView({ result: {} })).toEqual({ text: 'answered', warn: false });
    expect(serviceNoteView({ result: null, note: { outcome: 'no-answer', reason: 'timeout', ignoredTextParts: 0 } })).toEqual({ text: 'no answer: timeout', warn: true });
  });
});

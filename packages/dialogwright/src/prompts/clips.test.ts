import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY_PARTS } from '../testing/testkit/domain/systems';
import { DAY_PART_DISPLAY } from '../testing/testkit/domain/slots/shared';
import { FORM_INTENTS, INTENTS } from '../testing/testkit/domain/intents';
import { clipVersions, discoverClips, recordableClips, vocabularyClipId } from './clips';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';

useTestkit();

describe('discoverClips', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps clip ids to filenames for wav and mp3 and ignores everything else', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'part.morning.mp3'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    writeFileSync(join(dir, '.gitkeep'), '');
    expect(discoverClips(dir)).toEqual(new Map([['greeting.0', 'greeting.0.wav'], ['part.morning', 'part.morning.mp3']]));
  });
  it('returns an empty map for a missing directory', () => {
    expect(discoverClips(join(dir, 'nope')).size).toBe(0);
  });
  it('rejects one id recorded in two formats', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), '');
    writeFileSync(join(dir, 'greeting.0.mp3'), '');
    expect(() => discoverClips(dir)).toThrow(/greeting\.0.*wav.*mp3|greeting\.0.*mp3.*wav/);
  });
  it('discovers an uppercase extension, keeping the id case as written', () => {
    writeFileSync(join(dir, 'Greeting.0.WAV'), '');
    expect(discoverClips(dir)).toEqual(new Map([['Greeting.0', 'Greeting.0.WAV']]));
  });
  it('ignores a subdirectory even when its name looks like a clip file', () => {
    mkdirSync(join(dir, 'sub.wav'));
    expect(discoverClips(dir).size).toBe(0);
  });
});

describe('clipVersions', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'audio-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends a content-hash query string, distinct per file, that changes when the file changes', () => {
    writeFileSync(join(dir, 'greeting.0.wav'), 'hello');
    writeFileSync(join(dir, 'goodbye.0.wav'), 'goodbye');
    const clips = discoverClips(dir);
    const versions = clipVersions(dir, clips);
    const greeting = versions.get('greeting.0');
    const goodbye = versions.get('goodbye.0');
    expect(greeting).toMatch(/^greeting\.0\.wav\?v=[0-9a-f]{10}$/);
    expect(goodbye).toMatch(/^goodbye\.0\.wav\?v=[0-9a-f]{10}$/);
    expect(greeting).not.toBe(goodbye);

    writeFileSync(join(dir, 'greeting.0.wav'), 'hello, rewritten');
    const rewritten = clipVersions(dir, discoverClips(dir)).get('greeting.0');
    expect(rewritten).not.toBe(greeting);
  });
});

describe('vocabularyClipId', () => {
  it('maps display values back to clip ids', () => {
    expect(vocabularyClipId(testkitApp, 'part', 'in the morning')).toBe('part.morning');
    expect(vocabularyClipId(testkitApp, 'intentLabel', 'report a missing parcel')).toBe('intent.report_missing');
    expect(vocabularyClipId(testkitApp, 'a', 'track a parcel')).toBe('intent.track_parcel');
    expect(vocabularyClipId(testkitApp, 'b', 'book a delivery window')).toBe('intent.delivery_window');
    expect(vocabularyClipId(testkitApp, 'part', 'in the small hours')).toBeNull();
    // a part-of-day display under an intent variable, and an intent label under part, are not clips
    expect(vocabularyClipId(testkitApp, 'a', 'in the morning')).toBeNull();
    expect(vocabularyClipId(testkitApp, 'part', 'track a parcel')).toBeNull();
    // `first` is vocabulary (no seam rule) but has no recorded values
    expect(vocabularyClipId(testkitApp, 'first', 'Alex')).toBeNull();
    expect(vocabularyClipId(testkitApp, 'accountId', '5550 1234')).toBeNull();
    expect(vocabularyClipId(testkitApp, 'expectedDate', 'September 15')).toBeNull();
  });
  it('resolves every part of the day display and every form intent label', () => {
    for (const p of DAY_PARTS) expect(vocabularyClipId(testkitApp, 'part', DAY_PART_DISPLAY[p])).toBe(`part.${p}`);
    for (const i of FORM_INTENTS) {
      for (const name of ['intentLabel', 'a', 'b']) expect(vocabularyClipId(testkitApp, name, INTENTS[i]!.label)).toBe(`intent.${i}`);
    }
  });
});

describe('an app without a vocabulary', () => {
  const other = { ...testkitApp, id: 'other', prompts: { manifest: { hello: { text: 'Hello, {first}. How can I help?', interruptible: true } }, tags: {} } };
  it('has clips only for its own manifest', () => {
    expect(recordableClips(other)).toEqual([
      { id: 'hello.0', text: 'Hello,', note: 'open' },
      { id: 'hello.1', text: 'How can I help?', note: 'closed' },
    ]);
  });
  it('speaks every vocabulary value by TTS', () => {
    expect(vocabularyClipId(other, 'intentLabel', 'report a missing parcel')).toBeNull();
    expect(vocabularyClipId(other, 'part', 'in the morning')).toBeNull();
  });
});

describe('recordableClips', () => {
  it('lists every fixed segment and every vocabulary clip once, with text and intonation', () => {
    const rows = recordableClips(testkitApp);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find((r) => r.id === 'greeting.0')).toMatchObject({
      text: "Thanks for calling Example Parcels. You're speaking with the automated assistant. I can track a parcel, check a delivery window, or report a missing parcel. How can I help?",
      note: 'closed',
    });
    expect(rows.find((r) => r.id === 'window_open.0')).toMatchObject({ text: 'On', note: 'open' });
    expect(rows.find((r) => r.id === 'window_open.1')).toMatchObject({ text: 'we can deliver', note: 'open' });
    expect(rows.find((r) => r.id === 'confirm_report.1')).toMatchObject({ text: 'and I have your description. Shall I file the report?', note: 'closed' });
    expect(rows.find((r) => r.id === 'part.morning')).toMatchObject({ text: 'in the morning', note: 'closed' });
    expect(rows.find((r) => r.id === 'intent.report_missing')).toMatchObject({ text: 'report a missing parcel', note: 'closed' });
    expect(rows.filter((r) => r.id.startsWith('part.'))).toHaveLength(3);
    expect(rows.filter((r) => r.id.startsWith('intent.'))).toHaveLength(3);
    expect(rows.some((r) => r.id === 'accountId' || r.id.startsWith('parcel.'))).toBe(false);
    // A trailing "." after a variable (e.g. "Thanks, {first}.") has nothing left to record
    // once its leading punctuation is stripped, so it is not a recordable row.
    expect(rows.some((r) => r.text === '')).toBe(false);
    expect(rows.some((r) => r.id === 'identity_verified.1')).toBe(false);
    // a line that carries data is spoken whole by TTS, so none of it is recorded
    expect(rows.some((r) => r.id.startsWith('parcel_status_in_transit.'))).toBe(false);
  });
  it('matches the recorded snapshot of clip ids and notes', () => {
    expect(recordableClips(testkitApp)).toMatchSnapshot();
  });
  it('gives every clip an id the filename grammar accepts, so a generated file is never silently ignored', () => {
    for (const r of recordableClips(testkitApp)) expect(r.id, r.id).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});

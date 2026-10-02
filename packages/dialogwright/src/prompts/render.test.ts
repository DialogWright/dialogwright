import { describe, expect, it } from 'vitest';
import { testkitApp } from '../testing/testkit';
import { useTestkit } from '../testing/apps';
import { renderTemplate, promptText, promptEntry, decisionToActions, promptSay, handoffPromptId, spokenText, type RenderContext } from './render';
import type { App } from '../core/app/types';
import type { Decision } from '../core/decision';
import { actionsToFrames } from '../channel/relay/map';
import { endAction, sayAction, transferAction } from '../channel/actions';
import manifest from '../testing/testkit/prompts/manifest.json';
import { DAY_PARTS } from '../testing/testkit/domain/systems';
import { DAY_PART_DISPLAY, deliveryPartSlot } from '../testing/testkit/domain/slots/deliveryPart';
import { FORMS } from '../testing/testkit/domain/forms';
import { INTENTS, MENU } from '../testing/testkit/domain/intents';
import { SLOTS } from '../testing/testkit/domain/slots';
import { testSlotContext } from '../testing/slots';
import { textFrame } from '../channel/relay/frames';
import { recordableClips, vocabularyClipId } from './clips';
import { isPauseOnly, joinSpoken, segmentTemplate, stripLeadingPause, ttsOnly, VAR, type Segment } from './segments';

useTestkit();

const app = testkitApp;

/** A decision as the relay puts it on the wire: the frame-level tests below pin these bytes. */
const decisionToFrames = (app: App, decision: Decision, ctx?: RenderContext | null) => actionsToFrames(decisionToActions(app, decision, ctx));
/** One prompt as the relay puts it on the wire. */
const promptFrames = (app: App, promptId: string, vars: Record<string, string>, interruptible: boolean, ctx?: RenderContext | null) =>
  actionsToFrames([promptSay(app, promptId, vars, interruptible, ctx)]);

describe('renderTemplate', () => {
  it('substitutes variables', () => {
    expect(renderTemplate('Thanks, {first}.', { first: 'Alex' })).toBe('Thanks, Alex.');
  });
  it('throws on a missing variable', () => {
    expect(() => renderTemplate('Due {expectedDate}.', {})).toThrow(/expectedDate/);
  });
});

describe('manifest', () => {
  it('has text and an interruptible flag for every prompt', () => {
    for (const [id, p] of Object.entries(manifest)) {
      expect(typeof p.text, id).toBe('string');
      expect(typeof p.interruptible, id).toBe('boolean');
    }
  });
  it('maps handoff reasons to prompt ids', () => {
    expect(handoffPromptId('live-agent')).toBe('handoff_live_agent');
    expect(manifest).toHaveProperty(handoffPromptId('max-attempts'));
    expect(manifest).toHaveProperty(handoffPromptId('system-failure'));
  });

  it('has a manifest entry for every informational intent, so a typo in the table fails here rather than on a live call', () => {
    const informational = Object.values(INTENTS).flatMap((i) => (i.kind === 'informational' && i.promptId ? [i.promptId] : []));
    expect(informational.length).toBeGreaterThan(0);
    for (const promptId of informational) {
      expect(() => promptEntry(app, promptId), promptId).not.toThrow();
    }
  });
});

describe('keypad prompts match the tables they read from', () => {
  it('lists every part of the day in keypad order with its 1-based digit, as the slot parses it', () => {
    const text = manifest.ask_deliveryPart_dtmf.text;
    let cursor = -1;
    DAY_PARTS.forEach((p, i) => {
      const at = text.indexOf(`the ${p}`, cursor + 1);
      expect(at, `${p} is listed after the previous part`).toBeGreaterThan(cursor);
      const stop = text.indexOf('.', at);
      expect(text.slice(at, stop === -1 ? undefined : stop), p).toContain(`press ${i + 1}`);
      expect(deliveryPartSlot.dtmf?.parse(String(i + 1), testSlotContext(''))?.value, p).toBe(p);
      cursor = at;
    });
  });

  it('offers every intent menu digit', () => {
    for (const { digit } of MENU) {
      expect(manifest.nomatch_dtmf_menu.text, digit).toContain(`press ${digit}`);
    }
  });

  it('reads every part of the day in keypad order in the spoken question and its retry', () => {
    for (const id of ['ask_deliveryPart', 'ask_deliveryPart_retry'] as const) {
      const text = manifest[id].text;
      let cursor = -1;
      for (const p of DAY_PARTS) {
        const at = text.indexOf(p, cursor + 1);
        expect(at, `${id}: ${p} is listed after the previous part`).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(text.split(', ').length, id).toBe(DAY_PARTS.length);
    }
  });
});

describe('spokenText', () => {
  it('joins the ack and prompt text straight from the manifest', () => {
    const text = spokenText(app, {
      kind: 'prompt', promptId: 'ask_deliveryDay', vars: {}, target: 'deliveryDay', options: [],
      acks: [{ promptId: 'identity_verified', vars: { first: 'Alex' } }],
    });
    expect(text).toBe(`${promptText(app, 'identity_verified', { first: 'Alex' })} ${promptText(app, 'ask_deliveryDay', {})}`);
  });

  it('is empty for decisions that say nothing', () => {
    expect(spokenText(app, { kind: 'ignore' })).toBe('');
    expect(spokenText(app, { kind: 'hold' })).toBe('');
  });
});

describe('decisionToActions', () => {
  const say = (id: string, vars: Record<string, string>, interruptible: boolean) => sayAction([{ text: promptText(app, id, vars) }], interruptible);

  it('asks for nothing on ignore and hold', () => {
    expect(decisionToActions(app, { kind: 'ignore' })).toEqual([]);
    expect(decisionToActions(app, { kind: 'hold' })).toEqual([]);
  });

  it('says a replay\'s words again, interruptible', () => {
    expect(decisionToActions(app, { kind: 'replay', text: 'What is your account ID?' })).toEqual([sayAction([{ text: 'What is your account ID?' }], true)]);
  });

  it('says a prompt\'s acks then the prompt, each a line with its own manifest flag', () => {
    expect(decisionToActions(app, {
      kind: 'prompt', promptId: 'anything_else', vars: {}, target: 'intent', options: [],
      acks: [{ promptId: 'report_filed', vars: { report: '1001' } }, { promptId: 'depot_unavailable', vars: {} }],
    })).toEqual([say('report_filed', { report: '1001' }, false), say('depot_unavailable', {}, true), say('anything_else', {}, true)]);
  });

  it('closes a completion with goodbye, nothing interruptible, then ends with what was completed', () => {
    const vars = { intentLabel: INTENTS.report_missing!.label };
    expect(decisionToActions(app, { kind: 'complete', form: 'report_missing', promptId: 'report_filed', vars: { report: '1001' }, acks: [{ promptId: 'ack_intent', vars }], completed: ['report_missing'] }))
      .toEqual([say('ack_intent', vars, false), say('report_filed', { report: '1001' }, false), say('goodbye', {}, false), endAction(['report_missing'])]);
    // A completion that is itself the goodbye is not said twice.
    expect(decisionToActions(app, { kind: 'complete', form: null, promptId: 'goodbye', vars: {}, acks: [], completed: ['track_parcel'] }))
      .toEqual([say('goodbye', {}, false), endAction(['track_parcel'])]);
  });

  it('transfers a handoff with its reason, what was done and queued, and the slots collected', () => {
    expect(decisionToActions(app, {
      kind: 'handoff', reason: 'needs-human', promptId: 'handoff_needs_human', acks: [{ promptId: 'depot_unavailable', vars: {} }],
      completed: ['track_parcel'], queued: ['report_missing'], slots: { accountId: '5550 1234' },
    })).toEqual([say('depot_unavailable', {}, false), say('handoff_needs_human', {}, false), transferAction('needs-human', ['track_parcel'], ['report_missing'], { accountId: '5550 1234' })]);
  });

  it('says a clip-backed prompt as one line of parts', () => {
    const ctx: RenderContext = { clips: new Map(recordableClips(app).map((c) => [c.id, `${c.id}.mp3`])), audioBase: 'https://h/audio/' };
    const actions = decisionToActions(app, { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [], target: 'intent', options: [] }, ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'say', interruptible: true });
    expect(actions[0]!.type === 'say' && actions[0]!.parts.every((p) => 'audio' in p && p.audio.startsWith('https://h/audio/'))).toBe(true);
  });
});

describe('decisionToFrames', () => {
  it('emits ack frames then the prompt frame', () => {
    const frames = decisionToFrames(app, {
      kind: 'prompt', promptId: 'ask_deliveryDay', vars: {}, target: 'deliveryDay', options: [],
      acks: [{ promptId: 'identity_verified', vars: { first: 'Alex' } }],
    });
    expect(frames).toEqual([
      { type: 'text', token: 'Thanks, Alex.', last: true, lang: 'en-US', interruptible: true, preemptible: false },
      { type: 'text', token: promptText(app, 'ask_deliveryDay', {}), last: true, lang: 'en-US', interruptible: true, preemptible: false },
    ]);
  });

  it('ends the call after a handoff prompt', () => {
    const frames = decisionToFrames(app, { kind: 'handoff', reason: 'identity', promptId: 'handoff_identity', acks: [], completed: [], queued: [], slots: {} });
    expect(frames[1]).toEqual({ type: 'end', handoffData: '{"reasonCode":"identity"}' });
  });

  it('emits nothing for ignore and hold', () => {
    expect(decisionToFrames(app, { kind: 'ignore' })).toEqual([]);
    expect(decisionToFrames(app, { kind: 'hold' })).toEqual([]);
  });

  it('plays an ack with its own manifest flag, so the new report number is heard whole and the next steps can be talked over', () => {
    const frames = decisionToFrames(app, {
      kind: 'prompt', promptId: 'anything_else', vars: {}, target: 'intent', options: [],
      acks: [{ promptId: 'report_filed', vars: { report: '1001' } }, { promptId: 'depot_unavailable', vars: {} }],
    });
    expect(frames.map((f) => (f.type === 'text' ? f.interruptible : f.type))).toEqual([false, true, true]);
  });

  it('keeps a handoff decision\'s capabilities ack non-interruptible, as a terminal decision\'s acks stay', () => {
    const frames = decisionToFrames(app, {
      kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent',
      acks: [{ promptId: 'capabilities', vars: {} }], completed: [], queued: [], slots: {},
    });
    expect(frames[0]).toMatchObject({ type: 'text', interruptible: false });
  });
});

describe('summary prompts', () => {
  it('read back every slot of the form they confirm, the description as acknowledged rather than read', () => {
    for (const [form, spec] of Object.entries(FORMS)) {
      if (spec.summaryPromptId === null) continue;
      const text = promptEntry(app, spec.summaryPromptId).text;
      // The caller's own account is never read back word for word: the summary says it has it.
      for (const slot of spec.slots) expect(text, `${form}: ${spec.summaryPromptId}`).toContain(slot === 'missingNote' ? 'your description' : `{${slot}}`);
    }
  });

  it('has a readback prompt for any slot whose policy asks for one', () => {
    // Nothing uses `always` today (a slot read back goes in the `summary`), so this loop asserts
    // nothing -- it is here to catch the missing prompt the day a slot opts back in.
    for (const spec of Object.values(SLOTS)) {
      if (spec.spokenConfirm === 'always') expect(Object.keys(manifest), spec.id).toContain(`confirm_${spec.id}`);
    }
  });

  it('leaves the completion line to say it is done, naming only the report number it filed', () => {
    const text = promptEntry(app, 'report_filed').text;
    const names = [...text.matchAll(VAR)].map((m) => m[1]);
    expect(names).toEqual(['report']);
  });
});

describe('completion and chaining', () => {
  it('no completion prompt ends the call by itself', () => {
    // The lines each form's completion can say; parcel_status_<status> and window_<open|full> name a family.
    const completionLines: Record<string, string[]> = {
      track_parcel: ['parcel_status_'],
      delivery_window: ['window_'],
      report_missing: ['report_filed', 'depot_'],
    };
    expect(Object.keys(completionLines).sort(), 'every form is listed').toEqual(Object.keys(FORMS).sort());
    for (const [form, prefixes] of Object.entries(completionLines)) {
      const ids = Object.keys(manifest).filter((id) => prefixes.some((prefix) => id.startsWith(prefix)));
      expect(ids.length, `${form}: ${prefixes.join(', ')} names no prompt`).toBeGreaterThan(0);
      for (const id of ids) expect(promptEntry(app, id).text, id).not.toMatch(/goodbye/i);
    }
  });

  it('speaks acks, the completion, then goodbye, then ends', () => {
    const frames = decisionToFrames(app, { kind: 'complete', form: 'report_missing', promptId: 'report_filed', vars: { report: '1001' }, acks: [{ promptId: 'ack_intent', vars: { intentLabel: INTENTS.report_missing!.label } }], completed: ['report_missing'] });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(['Sure, I can help you report a missing parcel.', 'Your report is filed. Your report number is 1001.', promptText(app, 'goodbye', {}), 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"completed","completed":["report_missing"]}' });
    // A caller who says they are done completes on the goodbye itself, which is not said twice.
    const done = decisionToFrames(app, { kind: 'complete', form: null, promptId: 'goodbye', vars: {}, acks: [], completed: ['track_parcel'] });
    expect(done.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual([promptText(app, 'goodbye', {}), 'end']);
  });

  it('speaks acks before a handoff and reports completed forms', () => {
    const frames = decisionToFrames(app, { kind: 'handoff', reason: 'needs-human', promptId: 'handoff_needs_human', acks: [{ promptId: 'depot_unavailable', vars: {} }], completed: ['track_parcel'], queued: [], slots: { accountId: '5550 1234' } });
    expect(frames.map((f) => (f.type === 'text' ? f.token : f.type))).toEqual(['The depot will be in touch with next steps.', 'This one needs a specialist. Connecting you now.', 'end']);
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"needs-human","completed":["track_parcel"],"slots":{"accountId":"5550 1234"}}' });
  });

  it('reports intents the call never started in the handoff data', () => {
    const frames = decisionToFrames(app, { kind: 'handoff', reason: 'live-agent', promptId: 'handoff_live_agent', acks: [], completed: ['track_parcel'], queued: ['report_missing'], slots: {} });
    expect(frames.at(-1)).toEqual({ type: 'end', handoffData: '{"reasonCode":"live-agent","completed":["track_parcel"],"queued":["report_missing"]}' });
  });
});

describe('decisionToFrames with clips', () => {
  const base = 'https://demo.example.test/audio/';
  const clips = new Map([
    ['greeting.0', 'greeting.0.wav'],
    ['disambiguate_intent.0', 'disambiguate_intent.0.wav'], ['disambiguate_intent.1', 'disambiguate_intent.1.wav'],
    ['intent.track_parcel', 'intent.track_parcel.wav'], ['intent.report_missing', 'intent.report_missing.wav'],
    ['window_open.0', 'window_open.0.wav'], ['window_open.1', 'window_open.1.mp3'],
    ['part.morning', 'part.morning.wav'],
    ['goodbye.0', 'goodbye.0.wav'],
  ]);
  const ctx = { clips, audioBase: base };
  const p = (source: string, interruptible: boolean) => ({ type: 'play', source, loop: 1, preemptible: false, interruptible });
  const t = (token: string, interruptible: boolean) => ({ type: 'text', token, last: true, lang: 'en-US', interruptible, preemptible: false });
  const intentLabels = { a: INTENTS.track_parcel!.label, b: INTENTS.delivery_window!.label };

  it('renders a fully recorded prompt as play frames', () => {
    const frames = decisionToFrames(app, { kind: 'prompt', promptId: 'greeting', vars: {}, acks: [], target: 'intent', options: [] }, ctx);
    expect(frames).toEqual([p(`${base}greeting.0.wav`, true)]);
  });

  it('plays vocabulary clips, speaks composed values, and drops bare punctuation after a clip', () => {
    const frames = decisionToFrames(app, {
      kind: 'prompt', promptId: 'window_open', target: null, options: [],
      vars: { day: 'Friday', part: DAY_PART_DISPLAY.morning },
      acks: [{ promptId: 'disambiguate_intent', vars: { a: INTENTS.track_parcel!.label, b: INTENTS.report_missing!.label } }],
    }, ctx);
    expect(frames).toEqual([
      p(`${base}disambiguate_intent.0.wav`, true), p(`${base}intent.track_parcel.wav`, true),
      p(`${base}disambiguate_intent.1.wav`, true), p(`${base}intent.report_missing.wav`, true),
      p(`${base}window_open.0.wav`, true), t('Friday', true), p(`${base}window_open.1.mp3`, true), p(`${base}part.morning.wav`, true),
    ]);
  });

  it('falls back to text per segment and joins text without a space before punctuation', () => {
    const partial = { clips: new Map([['identity_verified.0', 'identity_verified.0.wav']]), audioBase: base };
    const frames = decisionToFrames(app, { kind: 'prompt', promptId: 'ask_deliveryDay', vars: {}, target: 'deliveryDay', options: [], acks: [{ promptId: 'identity_verified', vars: { first: 'Alex' } }] }, partial);
    expect(frames).toEqual([p(`${base}identity_verified.0.wav`, true), t('Alex.', true), t(promptText(app, 'ask_deliveryDay', {}), true)]);
  });

  it('strips the leading pause from text that follows a clip', () => {
    const partial = { clips: new Map([['intent.track_parcel', 'intent.track_parcel.wav']]), audioBase: base };
    const frames = decisionToFrames(app, { kind: 'prompt', promptId: 'disambiguate_intent', vars: intentLabels, target: 'intent', options: [], acks: [] }, partial);
    expect(frames).toEqual([t('Would you like to', true), p(`${base}intent.track_parcel.wav`, true), t('or book a delivery window?', true)]);
  });

  it('renders exactly as today without a context', () => {
    const d = { kind: 'prompt' as const, promptId: 'ask_deliveryDay', vars: {}, target: 'deliveryDay' as const, options: [], acks: [{ promptId: 'identity_verified', vars: { first: 'Alex' } }] };
    expect(decisionToFrames(app, d, null)).toEqual(decisionToFrames(app, d));
    expect(decisionToFrames(app, d)).toEqual([t('Thanks, Alex.', true), t(promptText(app, 'ask_deliveryDay', {}), true)]);
    const w = { kind: 'prompt' as const, promptId: 'disambiguate_intent', vars: intentLabels, target: 'intent' as const, options: [], acks: [] };
    expect(decisionToFrames(app, w)).toEqual([t('Would you like to track a parcel, or book a delivery window?', true)]);
  });

  it('merges a whole text run around a vocabulary clip and plays the goodbye clip before the end frame', () => {
    // No clip for the ack's own words, so its text run has to be spoken around the intent clip.
    const partial = { clips: new Map([['intent.report_missing', 'intent.report_missing.wav'], ['goodbye.0', 'goodbye.0.wav']]), audioBase: base };
    const frames = decisionToFrames(app, {
      kind: 'complete', form: 'report_missing', promptId: 'report_filed', vars: { report: '1001' }, completed: ['report_missing'],
      acks: [{ promptId: 'ack_intent', vars: { intentLabel: INTENTS.report_missing!.label } }],
    }, partial);
    expect(frames).toEqual([
      t('Sure, I can help you', false), p(`${base}intent.report_missing.wav`, false), t('Your report is filed. Your report number is 1001.', false),
      p(`${base}goodbye.0.wav`, false),
      expect.objectContaining({ type: 'end' }),
    ]);
  });

  /** One value for every variable the manifest names, as the core would pass it. */
  const vars: Record<string, string> = {
    intentLabel: INTENTS.report_missing!.label,
    a: INTENTS.track_parcel!.label,
    b: INTENTS.delivery_window!.label,
    first: 'Alex',
    phoneLast4: '0101',
    parcel: '7101',
    item: 'a box of books',
    day: 'Friday',
    part: DAY_PART_DISPLAY.morning,
    expectedDate: 'September 15',
    report: '1001',
    days: '3',
  };

  it('is byte-identical to a manifest text frame for every prompt, with or without an empty context', () => {
    const empty = { clips: new Map<string, string>(), audioBase: base };
    for (const id of Object.keys(manifest)) {
      const expected = [textFrame(promptText(app, id, vars), true)];
      expect(promptFrames(app, id, vars, true, null), id).toEqual(expected);
      expect(promptFrames(app, id, vars, true, empty), id).toEqual(expected);
    }
  });

  describe('with every recordable clip present', () => {
    const full = new Map(recordableClips(app).map((r) => [r.id, `${r.id}.wav`]));
    const byId = new Map(recordableClips(app).map((r) => [r.id, r.text]));
    const fullCtx = { clips: full, audioBase: base };
    /** A variable is clip-backed when its display value is a recorded vocabulary clip; `first` is vocabulary with none. */
    const hasClip = (name: string): boolean => vocabularyClipId(app, name, vars[name]!) !== null;

    /**
     * A spec-derived reference, independent of promptFrames: a segment is clip-backed
     * (recordable) when it is a non-punctuation-only fixed run or a
     * vocabulary variable with a recorded value; everything else (a punctuation-only fixed
     * run, or a variable spoken by TTS) is TTS. TTS runs accumulate via joinSpoken; a run
     * immediately following a clip has its leading pause stripped, mirroring promptFrames'
     * flush rule.
     */
    function referenceSpokenText(id: string, template: string, vars: Record<string, string>): string {
      const isClipBacked = (s: Segment): boolean => (s.kind === 'fixed' ? !isPauseOnly(s.text) : hasClip(s.name));
      const recordingOf = (s: Segment): string => (s.kind === 'fixed' ? stripLeadingPause(s.text) : vars[s.name]!);
      const runs: string[] = [];
      let run: string[] = [];
      let afterClip = false;
      const flushRun = (): void => {
        if (run.length === 0) return;
        let text = joinSpoken(run);
        if (afterClip) text = stripLeadingPause(text);
        if (text) runs.push(text);
        run = [];
      };
      for (const s of segmentTemplate(id, template)) {
        if (isClipBacked(s)) {
          flushRun();
          runs.push(recordingOf(s));
          afterClip = true;
        } else {
          run.push(s.kind === 'fixed' ? s.text : vars[s.name]!);
        }
      }
      flushRun();
      return joinSpoken(runs);
    }

    it('plays a clip for every segment that has one, falling back to text only for the unrecorded vars', () => {
      for (const [id, entry] of Object.entries(manifest)) {
        const frames = promptFrames(app, id, vars, true, fullCtx);
        // A line that carries data is spoken whole by TTS, clips or no clips.
        if (ttsOnly(app, segmentTemplate(id, entry.text))) {
          expect(frames, id).toEqual([textFrame(promptText(app, id, vars), true)]);
          continue;
        }
        // The values this template speaks by TTS, longest first so a value inside another is not cut out of it.
        const unrecorded = segmentTemplate(id, entry.text)
          .flatMap((s) => (s.kind === 'var' && !hasClip(s.name) ? [vars[s.name]!] : []))
          .sort((x, y) => y.length - x.length);

        for (const f of frames) {
          if (f.type === 'play') continue;
          expect(f.type, id).toBe('text');
          const token = (f as { token: string }).token;
          // A text frame can only ever be unrecorded var values (adjacent ones merge into one
          // run), optionally with a punctuation-only fixed segment glued on (it has nowhere
          // else to attach when nothing plays after it — see the reference model above).
          const rest = unrecorded.reduce((acc, v) => acc.split(v).join(''), token);
          expect(rest, `${id}: unexpected text frame ${JSON.stringify(token)}`).toMatch(/^[\s,.?!;:]*$/);
          expect(rest.length, `${id}: ${JSON.stringify(token)} is not an unrecorded value`).toBeLessThan(token.length);
        }

        const actual = joinSpoken(
          frames.map((f) => {
            if (f.type === 'text') return (f as { token: string }).token;
            const source = (f as { source: string }).source;
            const clipId = source.slice(base.length, -'.wav'.length);
            const text = byId.get(clipId);
            expect(text, `${id}: no recordable text for clip ${clipId}`).toBeDefined();
            return text!;
          }),
        );

        const expected = referenceSpokenText(id, entry.text, vars);
        expect(actual, id).toBe(expected);
      }
    });

    it('speaks a line that carries data whole by TTS, even with a clip recorded for part of it', () => {
      const stray = { clips: new Map([...full, ['parcel_status_in_transit.0', 'parcel_status_in_transit.0.wav']]), audioBase: base };
      expect(ttsOnly(app, segmentTemplate('parcel_status_in_transit', manifest.parcel_status_in_transit.text))).toBe(true);
      expect(promptFrames(app, 'parcel_status_in_transit', vars, true, stray)).toEqual([textFrame(promptText(app, 'parcel_status_in_transit', vars), true)]);
    });

    it('ignores a clip recorded for a punctuation-only segment', () => {
      const stray = { clips: new Map([...full, ['identity_verified.1', 'identity_verified.1.wav']]), audioBase: base };
      const frames = promptFrames(app, 'identity_verified', vars, false, stray);
      expect(frames.some((f) => f.type === 'play' && f.source.endsWith('identity_verified.1.wav'))).toBe(false);
    });
  });
});

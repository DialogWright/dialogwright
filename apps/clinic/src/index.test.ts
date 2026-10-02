import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildQuestions, buildTurnState, defaultAppId, handoffPromptId, slotContext, validateApp } from 'dialogwright';
import { clinicApp, registerClinic } from './index';
import { ANSWERING, intent, provider, rescheduleAtSummary, say, started, tc } from './testing/turns';

/**
 * The engine's own lines a clinic call can reach. Left out, with why: the signed-in chat greetings
 * (the clinic signs no one in) and every identity line (signin_*, ask_otp*, otp_*, identity_*: the
 * clinic verifies no one).
 */
const ENGINE_PROMPT_IDS = [
  'greeting', 'greeting_chat', 'ask_intent', 'nomatch_open', 'nomatch_dtmf_menu', 'no_input',
  'ack_intent', 'confirm_intent_explicit', 'disambiguate_intent', 'ack_intent_then', 'ack_queued', 'bridge_next',
  'ack_frustration', 'offer_transfer', 'ack_declined', 'system_slow_dtmf_hint', 'system_slow_chat',
  'ask_change', 'confirm_dtmf', 'anything_else', 'goodbye', 'goodbye_chat', 'screen_reprompt', 'screen_reprompt_form',
] as const;

/** The engine's handoff reasons a clinic call can reach (not identity, nor role-person: no identity, no roles), and the clinic's own. */
const HANDOFF_REASONS = ['live-agent', 'frustrated', 'max-attempts', 'system-failure', 'needs-human', 'security', 'billing'] as const;

/** Every prompt id a clinic call can reach: the engine's, each slot's, each form's, and the scheduling hooks'. */
function reachablePromptIds(): string[] {
  const ids = new Set<string>([...ENGINE_PROMPT_IDS, ...HANDOFF_REASONS.map(handoffPromptId)]);
  for (const spec of Object.values(clinicApp.slots)) {
    ids.add(`ask_${spec.id}`);
    ids.add(`ask_${spec.id}_retry`);
    if (spec.dtmf) ids.add(`ask_${spec.id}_dtmf`);
    if (spec.partialPromptId) ids.add(spec.partialPromptId);
    if (spec.spokenConfirm === 'by-confidence') ids.add(`ack_${spec.id}`);
  }
  // The provider: two close names asked about, and the two help lines.
  for (const id of ['disambiguate_provider', 'ask_provider_name', 'provider_list']) ids.add(id);
  for (const form of Object.values(clinicApp.forms)) if (form.summaryPromptId) ids.add(form.summaryPromptId);
  for (const def of Object.values(clinicApp.intents)) if (def.promptId) ids.add(def.promptId);
  // The completions, and the scheduling hooks' lines.
  for (const id of ['schedule_confirmed', 'reschedule_confirmed', 'cancel_confirmed', 'appointment_details']) ids.add(id);
  for (const id of ['confirm_time', 'slot_nearest', 'slot_edge_earlier', 'slot_edge_later', 'no_appointment_found', 'no_openings']) ids.add(id);
  return [...ids].sort();
}

describe('the clinic app', () => {
  it('is a valid app, registered as the default', () => {
    expect(() => validateApp(clinicApp)).not.toThrow();
    expect(defaultAppId()).toBe('clinic');
    expect(() => registerClinic()).not.toThrow();
  });

  it('verifies no one, so every tool is at level 0', () => {
    expect(clinicApp.identity).toBeUndefined();
    expect(Object.values(clinicApp.policy.toolLevel)).toEqual([0, 0, 0, 0, 0]);
    expect(() => validateApp({ ...clinicApp, policy: { ...clinicApp.policy, toolLevel: { ...clinicApp.policy.toolLevel, bookAppointment: 1 } } })).toThrow(/no identity/);
  });

  it('has every prompt a call can reach, and only one it cannot (kept from an earlier version of this example)', () => {
    const manifest = clinicApp.prompts.manifest;
    const reachable = reachablePromptIds();
    for (const id of reachable) expect(Object.hasOwn(manifest, id), id).toBe(true);
    // A member ID is read back at the summary, so its implicit readback is never said.
    expect(Object.keys(manifest).filter((id) => !reachable.includes(id))).toEqual(['ack_memberId']);
    expect(Object.keys(manifest)).toHaveLength(68);
    expect(manifest.greeting!.text).toBe('Thanks for calling Example Family Practice. How can I help you today?');
  });
});

describe('the clinic questions (App.questions)', () => {
  const asked = (s: Parameters<typeof buildQuestions>[0], text = 'hello') => Object.keys(buildQuestions(s, slotContext(s, text, tc)));

  it('reads a part of the day outside a form and on a scheduling form, and a time move only at a scheduling summary', () => {
    const opener = started();
    expect(asked(opener)).toContain('timeOfDay');
    expect(asked(opener)).not.toContain('timePreference');
    const scheduling = say(opener, 'reschedule with dr chen', { ...intent('reschedule'), ...provider('chen') }).session;
    expect(asked(scheduling)).toContain('timeOfDay');
    expect(asked(scheduling)).not.toContain('timePreference');
    const summary = rescheduleAtSummary().session;
    expect(asked(summary)).toEqual(expect.arrayContaining(['timeOfDay', 'timePreference', 'changeSlot']));
    const cancel = say(opener, 'cancel with dr chen', { ...intent('cancel'), ...provider('chen') }).session;
    expect(asked(cancel)).not.toContain('timeOfDay');
    expect(cancel.form).toBe('cancel');
  });

  it('words the change question in the clinic\'s terms and offers only the form\'s slots, in order', () => {
    const s = rescheduleAtSummary().session;
    const q = buildQuestions(s, slotContext(s, 'no', tc)).changeSlot;
    expect(q?.type === 'choice' ? Object.keys(q.criteria) : []).toEqual(['name', 'dob', 'provider', 'date', 'none']);
    expect(q?.instructions).toMatch(/summary of their appointment/);
  });

  it('sends the model the caller record with the clinic\'s field beside the engine\'s', () => {
    const s = say(started(), 'reschedule with dr chen', { ...intent('reschedule'), ...provider('chen'), intentChange: ANSWERING }).session;
    expect(buildTurnState(s, { text: 'hi', isFinal: true, dtmf: null }, 0).caller).toEqual({ verified: false, level: 0, priorCalls: 0, openAppointment: true });
  });
});

describe('the engine API the clinic uses', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

  it("imports only the package's supported entries (the root, and dialogwright/testing for test support), never an engine subpath", () => {
    const all = files('src');
    expect(all.length).toBeGreaterThan(20);
    const reaching = all.filter((f) => /from 'dialogwright\/(?!testing')/.test(readFileSync(f, 'utf8')));
    expect(reaching).toEqual([]);
  });
});

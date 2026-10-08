import type { AuditDraft } from '../audit/types';
import { wordsOf, type SessionEvent } from '../channel/events';
import { maskId } from '../gate/principal';
import { isAnonymous, type ToolCall } from '../gate/types';
import type { GateEvent, KbSource, OfferSettled } from './lifecycle';
import type { CheckReconfirmed, FormStopped } from './checks';
import type { Decision } from './decision';
import type { ScreenResult } from './screen';
import type { Session } from './session';
import { saidCode } from './spokenCode';
import { appOf } from './app/registry';
import { identityOf } from './app/lookup';
import type { App } from './app/types';
import { configAuditDetail } from './app/configHash';
import { scrubbedDrafts, scrubberOf } from './recording';
import { kbAuditRow } from '../kb/record';

/**
 * What one turn tells the audit log. Built from what the turn already reports, after
 * the fact, so the handlers stay as they are. No PHI goes in: the calls are the gate events' own
 * redacted copies (redactCall: each param masked as its slot or policy.yaml's audit: says); identity is
 * recorded as a factor passed or failed, never the values; a tool's result is its one-line summary,
 * never its payload. What a tool or a downstream service adds is the app's own row (ToolDef.audit,
 * ServiceDef.audit), under the same rule, and each is masked as the call (or the side effect) it
 * follows: a raw value of a param recorded masked or never is masked wherever the row repeats it. A
 * keypad code never reaches a draft at all.
 */
export interface AuditInput {
  /** the session as the turn found it */
  before: Session;
  /** the session as the turn left it */
  after: Session;
  event: SessionEvent;
  decision: Decision;
  gateEvents: readonly GateEvent[];
  kb: KbSource | null;
  screen: ScreenResult | null;
  quarantined: boolean;
  /** The form a check ended this turn (core/checks.ts): its `form_stopped` row, before the call's end. */
  stopped?: FormStopped;
  /** The offer of the caller's number this turn settled (core/turn.ts): its `offer` row. */
  offer?: OfferSettled;
  /** The check whose read-back the caller said no to this turn (core/turn.ts): its `check_reconfirmed` row. */
  reconfirmed?: CheckReconfirmed;
}

/** A redacted call as one line: "createReport(accountId=...1234, missingNote=<38 chars>, expectedDate=2026-09-15)". */
export function describeCall(call: ToolCall): string {
  return `${call.tool}(${Object.entries(call.params).map(([k, v]) => `${k}=${v}`).join(', ')})`;
}

/** Each rule the gate checked, as "scope fail: parcel owner ...5678 · caller may see ...1234 only". */
function ruleLines(e: GateEvent): string[] {
  return e.decision.rules.map((r) => `${r.id} ${r.pass ? 'pass' : 'fail'}: ${r.compared}`);
}

/**
 * The drafts that follow a gate decision: what the call did, when the gate let it run. The tool's
 * own rows where it declares them (ToolDef.audit), else its one-line summary. The tool's own rows
 * are held to the call's declarations: a raw value of a param recorded masked or never is masked
 * wherever a row repeats it (core/recording.ts), as the summary and the rules' lines already are.
 */
function ranDrafts(app: App, e: GateEvent, after: Session, kb: KbSource | null): AuditDraft[] {
  const { call } = e.decision;
  if (e.summary === null) return [];
  const audit = app.tools[call.tool]?.audit;
  if (audit) return scrubbedDrafts(audit({ call, summary: e.summary, ...(e.ref !== undefined ? { ref: e.ref } : {}), after, kb }), scrubberOf(e.decision));
  return [{ type: 'tool_result', detail: { tool: call.tool, summary: e.summary } }];
}

export function auditDrafts(t: AuditInput): AuditDraft[] {
  const drafts: AuditDraft[] = [];
  const { before, after, event, decision } = t;
  const app = appOf(after);
  const { subjectKind } = identityOf(app);
  if (event.type === 'session.start' && decision.kind !== 'ignore') {
    // One of the app's subjects is named by their id's last four, under the subject kind's own word
    // (e.g. `customer`); anyone else by kind and level only.
    const p = after.principal;
    const subject = !isAnonymous(p) && p.kind === subjectKind ? { [p.kind]: maskId(p.id) } : {};
    // An app built from a folder (App.configHashes) also names the configuration in force: the combined
    // hash and each file's `<file>:<hash>` line, once per call. Any other app's row is as it was.
    drafts.push({ type: 'call_started', detail: { channel: after.channel, principal: p.kind, level: p.level, ...subject, ...configAuditDetail(app.configHashes) } });
  }
  // The portal's sign-in raised an anonymous web chat to one of the app's subjects. The factor is the
  // portal's own (multi-factor in production); nothing the subject typed took part in it.
  const signedIn = after.principal;
  if (event.type === 'auth.signed_in' && isAnonymous(before.principal) && !isAnonymous(signedIn) && signedIn.kind === subjectKind) {
    drafts.push({ type: 'identity', detail: { factor: 'portal_sign_in', pass: true, level: signedIn.level, [signedIn.kind]: maskId(signedIn.id) } });
  }
  if (t.screen?.error != null) drafts.push({ type: 'screen_error', detail: { error: t.screen.error } });
  if (t.quarantined) drafts.push({ type: 'screen_fired', detail: { hits: after.screenHits, value: t.screen?.value ?? null } });
  // The code said aloud: recorded whatever the turn went on to do, since the exposure happened
  // either way. The words are already masked (spokenCode.ts), so there is nothing of it to record.
  const words = wordsOf(event);
  if (words !== null && before.promptedFor === 'otp' && saidCode(words)) {
    drafts.push({ type: 'code_spoken', detail: { masked: true, reissued: decision.kind === 'prompt' && decision.promptId === 'otp_spoken_reissued' } });
  }
  // A downstream service's answer to the request this call was waiting on: the app's own row for it
  // (ServiceDef.audit), only when it is from the service the call asked. The answer is untrusted, so the
  // app records only what passed its check.
  if (event.type === 'service.result' && event.service === before.pendingService) {
    const row = app.services?.[event.service]?.audit?.(event.result, event.note);
    // Masked as the effect that asked was recorded (core/recording.ts carryScrub), where the answer carries its scrub.
    if (row) drafts.push(...scrubbedDrafts([row], scrubberOf(event)));
  }
  // An offer settled (the caller's number, or a value from the facts): what was asked, as the line was said, and what the
  // caller answered, and how (speech, the keypad, or no answer). Whether a yes is consent to anything
  // is the owner's question; the row records what was asked and answered. Before the turn's gate
  // rows: the answer came first, and a text it agreed to is sent after.
  if (t.offer) {
    const o = t.offer;
    const by = o.answer === 'none' ? null : event.type === 'user.key' ? 'keypad' : 'speech';
    drafts.push({ type: 'offer', detail: { slot: o.slot, source: o.source, promptId: o.promptId, said: o.said, answer: o.answer, by, ...(o.last4 !== undefined ? { last4: o.last4 } : {}), locale: o.locale } });
  }
  for (const e of t.gateEvents) {
    const { call, verdict, reason, needLevel } = e.decision;
    drafts.push({
      type: 'gate',
      detail: {
        tool: call.tool, call: describeCall(call), purpose: call.purpose ?? null, verdict,
        reason: reason ?? null, needLevel: needLevel ?? null, rules: ruleLines(e),
      },
    });
    drafts.push(...ranDrafts(app, e, after, t.kb));
  }
  // An answer read from the knowledge base that no tool's audit hook recorded (an informational
  // intent's passage, said with no gated read): the engine records it, as kbAnswerTool's hook would.
  if (t.kb !== null && !drafts.some((d) => d.type === 'kb_answer')) drafts.push(kbAuditRow(t.kb));
  // A form a check ended (core/checks.ts): which check, for what reason, and how the form ended.
  // `confirmed` only where the refusal was read back first and the caller said yes (the outcome's `confirm`).
  if (t.stopped) drafts.push({ type: 'form_stopped', detail: { form: t.stopped.form, action: t.stopped.action, reason: t.stopped.reason, then: t.stopped.then, ...(t.stopped.confirmed ? { confirmed: true } : {}) } });
  // A check's read-back the caller said no to: the deciding answer was corrected, and is asked again.
  if (t.reconfirmed) drafts.push({ type: 'check_reconfirmed', detail: { form: t.reconfirmed.form, action: t.reconfirmed.action, reason: t.reconfirmed.reason } });
  if (decision.kind === 'handoff') {
    // The slots the caller never confirmed, by id and never by value, for an app whose handoff marks
    // or leaves them out (HandoffData.unconfirmed): the note can say what to check with the caller.
    const detail: AuditDraft['detail'] = { reason: decision.reason, completed: [...decision.completed], queued: [...decision.queued] };
    if (decision.unconfirmed !== undefined) detail.unconfirmed = [...decision.unconfirmed];
    drafts.push({ type: 'handoff', detail });
    drafts.push({ type: 'call_ended', detail: { reason: 'handoff', completed: [...decision.completed] } });
  } else if (decision.kind === 'complete') {
    drafts.push({ type: 'call_ended', detail: { reason: 'completed', completed: [...decision.completed] } });
  }
  return drafts;
}

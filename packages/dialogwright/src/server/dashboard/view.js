// Pure functions from dashboard events to a view model. Plain JavaScript on purpose: the browser
// loads this file as a module with no build step, and vitest imports the same file. It therefore
// imports nothing -- what it needs from the app (its forms and slots, their names, the audit rows
// it reads facts from) arrives as the console metadata (src/server/dashboard/meta.ts ConsoleMeta),
// which the page hands to `configure` before it reduces anything. Types are in view.d.ts.
//
// Nothing here reads a record's `event.provider` (a session start's call ids and numbers): the
// route and the observer mask those server-side, and the page shows only `call_started.from`.
// Trace records arrive as v2 (the core's channel events); the route upgrades older ones.

/** @typedef {import('./events').DashboardEvent} DashboardEvent */

/**
 * The threshold each question id is decided against, by name. The gate ladder's own ids come from
 * src/core/gates.ts; ids missing here are the rows the ladder only reports (`info()`), which have
 * no tick to draw.
 */
const GATE_THRESHOLD = {
  addressedToSystem: 'GATE_ADDRESSED',
  intelligible: 'GATE_INTELLIGIBLE',
  utteranceComplete: 'GATE_COMPLETE',
  wantsHuman: 'GATE_WANTS_HUMAN',
  frustration: 'GATE_FRUSTRATION_HIGH',
  intentTentative: 'INTENT_TENTATIVE',
  intentChange: 'INTENT_CHANGE',
  secondIntent: 'INTENT_SECOND',
  confirmsYes: 'CONFIRM_YES',
  confirmsNo: 'CONFIRM_NO',
  changeSlot: 'SLOT_CHANGE',
  menuNumberSaid: 'MENU_NUMBER',
};

/** The ids that belong in the `gates` group: everything the ladder asks except `intent` itself. */
const GATE_IDS = new Set([
  'addressedToSystem', 'intelligible', 'utteranceComplete', 'wantsHuman', 'frustration',
  'rephrasingLastTurn', 'confusedByPrompt', 'spokeAMenuNumber', 'urgency', 'triedSelfService',
  'languageSwitch', 'intentTentative', 'intentChange', 'secondIntent', 'menuNumberSaid',
  // Only asked while a confirmation is pending, and then they get their own group; listed here
  // so a stale answer still lands somewhere sensible.
  'confirmsYes', 'confirmsNo', 'changeSlot',
]);

/** Moved into the `confirmation` group while one is pending. */
const CONFIRM_IDS = new Set(['confirmsYes', 'confirmsNo', 'changeSlot']);

/**
 * Gate rows whose name is not the question id they were decided from, so a decided row still
 * marks the right row decisive (src/core/gates.ts pushes these names).
 */
const DECIDED_ALIAS = {
  menuNumber: ['menuNumberSaid'],
  intentMargin: ['intent'],
  // A priority intent read strongly enough to take the turn (gates.ts priorityIntent): the intent
  // answer is what decided, whichever gate it took the turn from.
  priorityIntent: ['intent'],
};

/**
 * The confirmation gate reads one of the two answers, never both, so only the one its outcome
 * came from is the decisive row (src/core/gates.ts step 6).
 */
const CONFIRM_DECIDED_ALIAS = {
  confirmed: ['confirmsYes'],
  rejected: ['confirmsNo'],
};

/** The engine's handoff reasons (core/lifecycle.ts), in words; the app's own come with its metadata. */
const ENGINE_HANDOFF_REASONS = {
  'live-agent': 'caller asked for a person',
  identity: 'identity not verified',
  'max-attempts': 'too many retries',
  'needs-human': 'needs a person',
  security: 'repeated injection attempts',
  'system-failure': 'system failure',
};

/** A duration for a delivery note: `0.7 s`; `?` when the fact has no such number. */
function secs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '?';
}

/**
 * Delivery notes: what happened on the line to what the agent said, as a short sentence under the line
 * it concerns (the console otherwise shows none of it; the frame log has it). One entry per kind of fact
 * the server reports (a `delivery` event, server/dashboard/delivery.ts):
 *
 * - `on`: the line the note goes under. `agent`: the agent's line the fact concerns (the line of the
 *   fact's `turn` when it names one, else the latest); `caller`: the caller's latest line; null: under
 *   none, held for the notes up to the end of the next turn to read.
 * - `text(fact, held)`: the sentence, from the fact's fields, which are timings and short codes only,
 *   never anyone's words. `held` has the facts of the `on: null` kinds that came within the last turn.
 * - `replaces(fact)` (optional): the kinds of an earlier note on the same line that this one says better,
 *   and takes the place of (the adapter's decision that an interrupt was not the caller's replaces the
 *   interrupt's note, so the line reads one note, not two that disagree).
 * - `unsaid(fact)` (optional): true when the line was never said (a reply held for a caller who went on):
 *   the page shows it struck through.
 *
 * A fact is one of the adapter's frame-log lines under its kind's key, its fields flattened
 * (`{ resaid: { heardMs, expectedMs } }` is `{ kind: 'resaid', heardMs, expectedMs }`; a key's bare
 * value is `value`, and the line's other fields stay as they are), or the carrier's interrupt
 * (`interrupt`). To show a new kind: one line here, and the adapter writes its frame-log line through
 * `logDelivery` (server/adapter.ts). Live and on reload alike, nothing else changes.
 */
const SPURIOUS = 'spurious-interrupt';
export const DELIVERY_NOTES = {
  // A line the carrier cut short, said again (RESAY_CUT_LINES); or one an interrupt with no caller cut, said again.
  resaid: {
    on: 'agent',
    text: (f) => (f.reason === SPURIOUS
      ? `interrupted ${secs(f.afterMs)} in with no caller speaking, said again`
      : `cut off at ${secs(f.heardMs)} of about ${secs(f.expectedMs)}, said again`),
    replaces: (f) => (f.reason === SPURIOUS ? ['interrupt', 'spuriousInterrupt'] : []),
  },
  cutAgain: { on: 'agent', text: (f) => `cut short again at ${secs(f.heardMs)} of about ${secs(f.expectedMs)}, not said a third time` },
  // The carrier's interrupt of the line: the caller's, unless the adapter finds otherwise (spuriousInterrupt).
  interrupt: { on: 'agent', text: (f) => `caller talked over this, ${secs(f.afterMs)} in` },
  // The adapter's decision that an interrupt was not the caller's (RESAY_SPURIOUS_INTERRUPTS): not passed to the core.
  spuriousInterrupt: { on: 'agent', text: (f) => `interrupted ${secs(f.afterMs)} in with no caller speaking`, replaces: () => ['interrupt'] },
  // A reply held for a caller not finished (INCOMPLETE_WAIT_MS): said after the wait, or never, the caller going on.
  replyHeld: {
    on: 'agent',
    text: (f) => (f.outcome === 'joined' ? 'not said: the caller went on' : `reply held ${secs(f.ms)} for the caller to finish, then said`),
    unsaid: (f) => f.outcome === 'joined',
  },
  // A turn's `end` held until its lines played (END_AFTER_PLAYBACK); `value` is how it came to go.
  endAfter: { on: 'agent', text: (f) => ({
    played: `call end held ${secs(f.endHeldMs)} until it played`,
    estimate: `call end held ${secs(f.endHeldMs)}, the line's estimated length`,
    timeout: `call end held ${secs(f.endHeldMs)} until the time limit`,
    closed: `caller hung up ${secs(f.endHeldMs)} into it`,
  })[f.value] ?? `call end held ${secs(f.endHeldMs)}` },
  // The caller came back in over the reply to their last answer: `joined` reads its pause.
  callerResumed: { on: null },
  // The caller's words joined to their previous answer, as one turn (run/continuation.ts).
  joined: { on: 'caller', text: (f, held) => (held.callerResumed
    ? `joined with the previous answer (paused ${secs(held.callerResumed.pauseMs)})`
    : 'joined with the previous answer') },
};

/**
 * A delivery fact's note, or null for a kind the console does not show (not in DELIVERY_NOTES, or
 * `on: null`). `held` as DELIVERY_NOTES's `text` reads it. `replaces` lists the kinds of an earlier note
 * on the line it takes the place of, and `unsaid` says the line was never said.
 */
export function deliveryNote(fact, held) {
  const kind = fact?.kind;
  const entry = typeof kind === 'string' && Object.hasOwn(DELIVERY_NOTES, kind) ? DELIVERY_NOTES[kind] : null;
  if (!entry || !entry.on) return null;
  return {
    kind, on: entry.on, text: entry.text(fact, held ?? {}),
    replaces: entry.replaces ? entry.replaces(fact) : [],
    unsaid: entry.unsaid ? entry.unsaid(fact) === true : false,
  };
}

/** The console metadata in force: neutral until the page (or a test) configures the app's. */
let META = {
  formLabels: {}, slotLabels: {}, questionPrefixes: {}, detectQuestions: [], stepUp: [], chipStyle: {},
  handoffReasons: {}, facts: [], serviceNote: { label: 'Downstream service', answered: 'answered', reasons: {} },
  signIn: { marker: 'signed in · portal', role: null }, chatPrefixes: [],
};

/** Every slot of the app, in the order shown outside a form (ConsoleMeta.slotOrder). Filled by `configure`. */
export const ALL_SLOTS = [];

/** Each form's slots, in prompt order (ConsoleMeta.formSlots). Filled by `configure`. */
export const FORM_SLOTS = {};

/**
 * Takes the app's console metadata (ConsoleMeta, as the server inlines it in the page and answers
 * it at /dashboard/boot). ALL_SLOTS and FORM_SLOTS are refilled in place, so their importers see it.
 */
export function configure(meta) {
  META = { ...META, ...meta };
  ALL_SLOTS.splice(0, ALL_SLOTS.length, ...(meta.slotOrder ?? []));
  for (const k of Object.keys(FORM_SLOTS)) delete FORM_SLOTS[k];
  Object.assign(FORM_SLOTS, meta.formSlots ?? {});
}

/** The question id prefixes that belong to a slot: the app's where it gives them, else the slot id itself. */
function prefixesOf(slot) {
  return Object.hasOwn(META.questionPrefixes, slot) ? META.questionPrefixes[slot] : [slot];
}

/** The chip and group order for a form, or every slot outside one. */
function slotsOf(form) {
  return form && Object.hasOwn(FORM_SLOTS, form) ? FORM_SLOTS[form] : ALL_SLOTS;
}

function slotOf(id) {
  for (const slot of ALL_SLOTS) {
    const prefixes = prefixesOf(slot);
    if (prefixes.some((p) => id === p || id.startsWith(p))) return slot;
  }
  return null;
}

/**
 * Which threshold a row's bar draws its tick at, or null when the row is only reported.
 * `activeForm` is the form the batch was asked under, which is what the intent rung depends on.
 */
export function thresholdFor(id, thresholds, activeForm) {
  const t = thresholds ?? {};
  if (Object.hasOwn(GATE_THRESHOLD, id)) return t[GATE_THRESHOLD[id]] ?? null;
  if (/Given$/.test(id) || META.detectQuestions.includes(id)) return t.SLOT_DETECT ?? null;
  // INTENT_ROUTE is never applied: outside a form the ladder routes from INTENT_EXPLICIT up (the
  // lowest rung that still routes, with a confirmation), and inside one only a switch at
  // INTENT_SWITCH takes the turn away from the form (src/core/gates.ts step 8).
  if (id === 'intent') return (activeForm ? t.INTENT_SWITCH : t.INTENT_EXPLICIT) ?? null;
  if (slotOf(id)) return t.SLOT_CHOICE_CONFIRM ?? null;
  return null;
}

/**
 * One row per question, with the answer folded in when present. `questions` gives the row order
 * and, before the answers arrive, the pending rows; without it the answers decide.
 */
export function decisiveRows(answers, thresholds, gateRows, questions, activeForm) {
  const ids = questions ? Object.keys(questions) : Object.keys(answers ?? {});
  const named = new Set();
  /** The row the ladder actually built for a question id, when it built one; see the score branch. */
  const byGate = new Map();
  for (const g of gateRows ?? []) {
    if (!g) continue;
    if (!byGate.has(g.gate)) byGate.set(g.gate, g);
    if (!g.decided) continue;
    named.add(g.gate);
    const alias = g.gate === 'confirmation' ? CONFIRM_DECIDED_ALIAS[g.outcome] : DECIDED_ALIAS[g.gate];
    for (const id of alias ?? []) named.add(id);
  }
  return ids.map((id) => {
    const a = answers ? answers[id] : null;
    const threshold = thresholdFor(id, thresholds, activeForm);
    if (!a) return { id, kind: 'pending', p: null, value: null, threshold, decisive: false, top: null };
    if (a.type === 'noul') {
      const p = a.noul;
      return { id, kind: 'noul', p, value: p.toFixed(2), threshold, decisive: named.has(id) || (threshold !== null && p >= threshold), top: null };
    }
    const entries = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
    const top = entries.slice(0, 4).map(([label, p]) => ({ label, p }));
    if (a.type === 'choice') {
      const p = a.probabilities?.[a.choice] ?? null;
      const decisive = named.has(id) || (a.choice !== 'none' && threshold !== null && p !== null && p >= threshold);
      return { id, kind: 'choice', p, value: a.choice, threshold, decisive, top };
    }
    // A score's threshold is a rule about one level (`frustration.high`), not about the winning
    // level, so a bar of the winning level's probability with that tick would compare two
    // different numbers. The bar takes the pair the ladder itself compared -- the gate row's
    // `value` and `threshold` -- and the value stays the winning level. A score no gate reads
    // (`urgency`) has no such pair, and no bar; only a gate row can call a score row decisive.
    const winner = entries[0];
    const row = byGate.get(id);
    const level = winner ? winner[0] : String(a.score ?? '');
    return {
      id, kind: a.type,
      p: typeof row?.value === 'number' ? row.value : null,
      value: level,
      threshold: typeof row?.threshold === 'number' ? row.threshold : null,
      decisive: named.has(id), top,
    };
  });
}

/** Groups rows: gates, intent, confirmation (when pending), then one group per form slot in form order. */
export function groupRows(rows, formSlots, pending) {
  const gates = { name: 'gates', rows: [] };
  const intent = { name: 'intent', rows: [] };
  const confirmation = { name: 'confirmation', rows: [] };
  const fixed = pending ? [gates, intent, confirmation] : [gates, intent];
  const slotGroups = new Map((formSlots ?? ALL_SLOTS).map((s) => [s, { name: `slot · ${s}`, rows: [] }]));
  // A slot the current form does not have is still a slot: `other` is for ids no slot owns.
  const offForm = new Map();
  const other = { name: 'other', rows: [] };
  for (const r of rows) {
    if (pending && CONFIRM_IDS.has(r.id)) confirmation.rows.push(r);
    else if (GATE_IDS.has(r.id)) gates.rows.push(r);
    else if (r.id === 'intent') intent.rows.push(r);
    else {
      const s = slotOf(r.id);
      if (s && slotGroups.has(s)) slotGroups.get(s).rows.push(r);
      else if (s) {
        if (!offForm.has(s)) offForm.set(s, { name: `slot · ${s}`, rows: [] });
        offForm.get(s).rows.push(r);
      } else other.rows.push(r);
    }
  }
  const extra = ALL_SLOTS.filter((s) => offForm.has(s)).map((s) => offForm.get(s));
  const out = fixed.concat([...slotGroups.values()], extra);
  if (other.rows.length) out.push(other);
  return out.map((g) => ({ ...g, decisive: g.rows.some((r) => r.decisive), quiet: g.rows.filter((r) => !r.decisive).length }));
}

/** A slot's pending narrowing, as the chip and the decision line say it: a dob month and day. */
function partialLabel(w) {
  if (!w) return '';
  // A date of birth part-given reaches the page masked to zeroes (src/trace/redact.ts).
  if (!w.month) return '••/••';
  return `${w.month}/${w.day}`;
}

function sameWindow(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function chipsOf(slots, prevSlots, form) {
  return slotsOf(form).map((id) => {
    const s = (slots && slots[id]) || { value: null, display: null, window: null, attempts: 0 };
    const prev = prevSlots ? prevSlots[id] : null;
    return {
      id,
      state: s.value ? 'filled' : s.window ? 'partial' : 'empty',
      label: s.value ? (Object.hasOwn(META.chipStyle, id) && META.chipStyle[id] === 'value' ? s.value : (s.display ?? s.value)) : s.window ? partialLabel(s.window) : '',
      changed: !!prev && (prev.value !== s.value || !sameWindow(prev.window, s.window)),
      attempts: s.attempts ?? 0,
    };
  });
}

/** What this turn did to the form, in words: only the slots that moved. */
function changedSlots(slots, prevSlots) {
  const out = [];
  if (!slots) return out;
  for (const id of ALL_SLOTS) {
    const s = slots[id];
    if (!s) continue;
    const prev = prevSlots ? prevSlots[id] : null;
    if (s.value) {
      if (!prev || prev.value !== s.value) out.push(`${id} filled ${s.value}`);
    } else if (s.window && (!prev || !sameWindow(prev.window, s.window))) {
      out.push(`${id} → ${partialLabel(s.window)}`);
    } else if (prev && prev.value) {
      out.push(`${id} cleared`);
    }
  }
  return out;
}

/** Which gate decided, which slots moved, and what is asked next. */
function decisionLine(record, changed) {
  const d = record.decision;
  const parts = [];
  const decided = (record.gates ?? []).find((g) => g.decided);
  if (decided) parts.push(`${decided.gate}: ${decided.outcome}`);
  parts.push(...changed);
  if (d.kind === 'prompt') parts.push(`next: ${d.promptId}`);
  else if (d.kind === 'complete') parts.push(`complete: ${d.promptId}`);
  else if (d.kind === 'handoff') parts.push(`handoff: ${d.reason}`);
  else parts.push(d.kind);
  return parts.join(' · ');
}

/**
 * The pending confirmation, with what is being confirmed: `form`, `slot` and `intent` alone say
 * only which kind of question is out. Reads both shapes of the pending state -- the session's
 * (src/core/session.ts) and the flatter one a TurnState carries.
 */
function pendingLine(pending) {
  if (!pending) return null;
  const subject = pending.target === 'form' ? pending.form : pending.target === 'intent' ? pending.intent : pending.slot ?? pending.target;
  const named = subject ?? pending.value ?? '?';
  if (pending.target === 'form') {
    // Only the form summary counts unanswered turns; an intent or slot readback has no counter.
    const attempts = typeof pending.attempts === 'number' ? ` · attempt ${pending.attempts}` : '';
    return `confirm · summary (${named})${attempts}`;
  }
  if (pending.target === 'intent') return `confirm · ${named}`;
  const value = pending.display ?? pending.value ?? '';
  return `confirm · ${named}${value ? ` → ${value}` : ''}`;
}

function askingLine(record, thresholds) {
  const id = record.promptedFor;
  if (!id || id === 'intent' || id === 'confirm') return null;
  const slot = record.slots ? record.slots[id] : null;
  if (!slot) return null;
  return `asking ${id} · attempt ${(slot.attempts ?? 0) + 1} of ${thresholds.MAX_ATTEMPTS ?? 3}`;
}

function money(usd) {
  return `$${usd.toFixed(4)}`;
}

/** The middle value (the mean of the two middle ones for an even count); 0 for none. */
function median(xs) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tokensOf(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

/**
 * A redacted call as one line: "tool(id=...1234, kind=a, statement=<38 chars>)". Mirrors
 * core/audit.ts's `describeCall`, which view.js cannot import: the call it is given is already the
 * gate's redacted copy (core/lifecycle.ts's `redactCall`), so nothing here ever sees a raw
 * identifier, date or statement.
 */
function displayCall(call) {
  return `${call.tool}(${Object.entries(call.params).map(([k, v]) => `${k}=${v}`).join(', ')})`;
}

/** The screen stage: skip on a turn with no speech to screen at all. */
function screenStage(record) {
  const s = record.screen;
  if (s == null) return { state: 'skip', label: 'no speech' };
  if (s.fired) return { state: 'fail', label: 'quarantined' };
  if (s.error) return { state: 'warn', label: 'screen error' };
  return { state: 'pass', label: 'clear' };
}

/** The perception stage: discarded on a quarantined turn, idle when the model was never asked. */
function perceptionStage(record, consulted) {
  if (record.quarantined) return { state: 'skip', label: 'discarded' };
  if (!consulted) return { state: 'idle', label: 'idle' };
  return { state: 'pass', label: 'ran' };
}

/**
 * The dialog-policy stage: what the gate ladder (src/core/gates.ts) decided this turn, read off
 * its own decided row so the label always matches `decisionLine`'s. The screen's own row (first on
 * a screened turn, decided when it fires) is not the dialog policy's decision, so it is skipped.
 * Many turns act with no gate row deciding (a slot answered in form, a keypad code, the greeting):
 * those read what the policy did instead, the slots it filled and what it said next, so a turn
 * the caller heard something on never reads idle. Only a turn that decided nothing and said
 * nothing (an ignored interrupt, a hold) is idle.
 */
function policyStage(record, filled) {
  const decided = (record.gates ?? []).find((g) => g.decided && g.gate !== 'screen');
  if (decided) return { state: 'pass', label: decided.outcome };
  const d = record.decision;
  const parts = filled.length > 0 ? [`filled ${filled.join(', ')}`] : [];
  if (d.kind === 'prompt') parts.push(d.promptId);
  else if (d.kind === 'complete') parts.push(`complete: ${d.promptId}`);
  else if (d.kind === 'handoff') parts.push(`handoff: ${d.reason}`);
  else if (d.kind === 'replay') parts.push('replay');
  if (parts.length === 0) return { state: 'idle', label: 'idle' };
  return { state: 'pass', label: parts.join(' · ') };
}

/** The slots this turn filled (a value it did not have before), by id only: no values, so no PHI. */
function filledSlots(slots, prevSlots) {
  if (!slots) return [];
  return ALL_SLOTS.filter((id) => {
    const s = slots[id];
    const prev = prevSlots ? prevSlots[id] : null;
    return !!s && !!s.value && (!prev || prev.value !== s.value);
  });
}

/** The action-gate stage: this turn's last gate event (a turn may call more than one tool). */
function gateStage(record) {
  const events = record.gateEvents ?? [];
  const last = events[events.length - 1];
  if (!last) return { state: 'idle', label: 'no call' };
  const v = last.decision.verdict;
  const state = v === 'ALLOW' ? 'pass' : v === 'BLOCK' ? 'fail' : 'warn'; // STEP_UP, NEEDS_HUMAN
  return { state, label: v };
}

/**
 * The audit stage: how many entries this turn drafted. Read off the record's own `audit` (the
 * drafts, before chaining), not the live `audit` bus event, so a turn's count is available the
 * moment its `turn` event arrives and a replayed trace can draw it the same way.
 */
function auditStage(record) {
  const n = record.audit ? record.audit.length : 0;
  return { state: 'pass', label: `${n} ${n === 1 ? 'entry' : 'entries'}` };
}

/** The five stages the console draws for one caller turn. */
function stagesOf(record, consulted, filled) {
  return {
    screen: screenStage(record),
    perception: perceptionStage(record, consulted),
    policy: policyStage(record, filled),
    gate: gateStage(record),
    audit: auditStage(record),
  };
}

/**
 * The latest action-gate decision, for the console's gate card: the redacted call, its verdict,
 * every rule it checked, and the turn it came from (so the card can say "turn 5" or, once a later
 * turn made no call of its own, "last call: turn 5").
 */
function gateViewOf(e, turnIndex) {
  const d = e.decision;
  return {
    display: displayCall(d.call),
    verdict: d.verdict,
    reason: d.reason ?? null,
    rules: d.rules.map((r) => ({ id: r.id, description: r.description, compared: r.compared, pass: r.pass })),
    turnIndex,
  };
}

/**
 * The knowledge-base source card: field names the console shows, mapped from KbSource
 * (core/lifecycle.ts). Whom it answered is one "fact: value" line per fact, sorted. A record
 * written before the record had `applies` (with a `plan` of its own) shows none: the console never
 * reads the deprecated field. Absent fields are null, so the card can leave their lines out.
 */
function sourceOf(kb) {
  const applies = Object.keys(kb.applies ?? {}).sort().map((k) => `${k}: ${kb.applies[k]}`);
  return {
    passageId: kb.passageId, document: kb.document, section: kb.section, version: kb.version,
    effective: kb.effectiveFrom, effectiveTo: kb.effectiveTo ?? null,
    approved: kb.approvedOn ?? null, approvedBy: kb.approvedBy ?? null, fresh: kb.fresh,
    applies, locale: kb.locale ?? null, sourceHash: kb.sourceHash ?? null, approvalHash: kb.approvalHash ?? null,
  };
}

/** A handoff's collected slots (already display-safe; redactRecordSlots masked identity before this), one line each. */
function packetOf(slots) {
  return Object.entries(slots ?? {}).map(([k, v]) => `${k}: ${v}`);
}

/** One audit entry as a console line: "gate(tool=lookUp, verdict=BLOCK, ...)". No PHI to hide (core/audit.ts). */
function auditLine(e) {
  const parts = Object.entries(e.detail ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`);
  return `${e.type}(${parts.join(', ')})`;
}

/**
 * The identity level a turn's last `identity` audit draft left the caller at (core/audit.ts), or
 * null when the turn verified nothing. Read off the record's own drafts so live and replay agree.
 */
function levelOf(drafts) {
  const found = (drafts ?? []).filter((d) => d && d.type === 'identity').at(-1);
  const level = found?.detail?.level;
  return level === 0 || level === 1 || level === 2 ? level : null;
}

/**
 * The whole call's audit entries, newest last: the page shows them in a list that scrolls on its
 * own, following the newest, so the start of the call is a scroll away once it ends. The cap only
 * guards a runaway call.
 */
const AUDIT_TAIL_MAX = 500;

/** Appends live audit entries to the tail, keeping at most AUDIT_TAIL_MAX, newest last. */
function pushAudit(v, entries) {
  for (const e of entries) v.auditTail.push({ seq: e.seq, type: e.type, line: auditLine(e), hash: e.hash.slice(0, 8), fromTrace: false });
  if (v.auditTail.length > AUDIT_TAIL_MAX) v.auditTail = v.auditTail.slice(-AUDIT_TAIL_MAX);
}

/**
 * Same trimming, for the tail replay reconstructs from a record's own `audit` (TraceRecord.audit:
 * the turn's drafts, before chaining -- see trace/types.ts). Only reached with `reduce`'s
 * `fromTrace` option, which only replay ever passes: a live call always gets a real `audit` bus
 * event first, and pushing both would double every entry.  A draft has no `seq` or `hash` yet --
 * those are the sink's, stamped once a live call chains it -- so each row says so instead of
 * showing a stale or fabricated one (auditHtml reads `fromTrace` for that).
 */
function pushAuditDrafts(v, drafts) {
  for (const d of drafts) v.auditTail.push({ seq: null, type: d.type, line: auditLine(d), hash: null, fromTrace: true });
  if (v.auditTail.length > AUDIT_TAIL_MAX) v.auditTail = v.auditTail.slice(-AUDIT_TAIL_MAX);
}

/** A form id in words: the app's label for it (ConsoleMeta.formLabels), or the id with spaces. */
export function formLabel(form) {
  if (!form) return '';
  return Object.hasOwn(META.formLabels, form) ? META.formLabels[form] : String(form).replace(/_/g, ' ');
}

/** Why the call went to a person, in words: the engine's handoff reasons and the app's; anything else as it is. */
export function handoffReasonText(reason) {
  const r = String(reason ?? '');
  if (Object.hasOwn(META.handoffReasons, r)) return META.handoffReasons[r];
  return Object.hasOwn(ENGINE_HANDOFF_REASONS, r) ? ENGINE_HANDOFF_REASONS[r] : r.replace(/[_-]/g, ' ');
}

/** A transfer number worth showing: the adapter's masked `…9110`, not the bare `…` replay has. */
function shownNumber(number) {
  return typeof number === 'string' && /\d/.test(number) ? number : null;
}

/** A slot as the NOW panel names it (ConsoleMeta.slotLabels), or its id. */
function slotName(id) {
  return Object.hasOwn(META.slotLabels, id) ? META.slotLabels[id] : null;
}

/** Whether the agent is prompting for an identity factor or the keypad code: stepping the caller up. */
function steppingUp(promptedFor) {
  return promptedFor === 'otp' || META.stepUp.includes(promptedFor);
}

/**
 * One NOW chip's value, never an identifier in full (ConsoleMeta.chipStyle): an identifier only by
 * its last four (the record's display is already `...1234`; anything else is masked again here), a
 * verified factor only as given or verified, the caller's own words only as recorded (live they
 * are the words, in replay their length), and a slot shown as said by its written value.
 */
function nowChipLabel(id, s, level) {
  const style = Object.hasOwn(META.chipStyle, id) ? META.chipStyle[id] : null;
  if (s.value) {
    if (style === 'last4') {
      const shown = String(s.display ?? s.value);
      return /^(\.\.\.|…)\d{4}$/.test(shown) ? shown : `…${shown.replace(/\D/g, '').slice(-4)}`;
    }
    if (style === 'verified') return level >= 1 ? 'verified' : 'given';
    if (style === 'recorded') return 'recorded';
    if (style === 'value') return String(s.value);
    return String(s.display ?? s.value);
  }
  if (s.window) return style === 'verified' ? 'partial' : partialLabel(s.window);
  return '';
}

/**
 * The NOW panel's chips: the form's own slots, preceded by the identity factor slots while the
 * agent is stepping the caller up (asking for a factor or the keypad code).
 */
function nowChipsOf(slots, form, promptedFor, level) {
  const ids = [...(steppingUp(promptedFor) ? META.stepUp : []), ...slotsOf(form)];
  return ids.map((id) => {
    const s = (slots && slots[id]) || { value: null, display: null, window: null, attempts: 0 };
    return { id, name: slotName(id) ?? id, state: s.value ? 'filled' : s.window ? 'partial' : 'empty', label: nowChipLabel(id, s, level) };
  });
}

/** What the agent is waiting on this turn, in words, for the NOW panel. */
function nowAskingOf(record, thresholds) {
  const p = record.pendingConfirmation;
  if (p) {
    if (p.target === 'form') return 'confirming the summary with the caller';
    if (p.target === 'intent') return `confirming: ${formLabel(p.intent ?? p.form).toLowerCase() || 'the request'}`;
    const name = ((p.slot != null ? slotName(p.slot) : null) ?? p.slot ?? 'a value').toLowerCase();
    return `confirming ${name}${p.display ? ` → ${p.display}` : ''}`;
  }
  const id = record.promptedFor;
  if (id === 'otp') return 'asking for the one-time code (keypad)';
  if (!id || id === 'intent' || id === 'confirm') return null;
  const slot = record.slots ? record.slots[id] : null;
  if (!slot) return null;
  return `asking ${id} · attempt ${(slot.attempts ?? 0) + 1} of ${thresholds.MAX_ATTEMPTS ?? 3}`;
}

/** A tool result summary in words: `in_review` reads "in review". */
const words = (s) => String(s ?? '').replace(/_/g, ' ');

/** Whether a fact rule (ConsoleMeta.facts) reads this audit draft. */
function ruleFits(rule, d, det, prev) {
  if (rule.kind === 'lookup') return d.type === 'tool_result' && det.tool === rule.tool;
  if (d.type !== rule.type) return false;
  if (rule.kind !== 'note') return true;
  return Object.entries(rule.when ?? {}).every(([k, v]) => det[k] === v) && !!prev && !prev.includes(rule.unless ?? rule.text);
}

/** The fact a rule makes of a draft it fits. */
function ruleFact(rule, record, prevSlots, prev, det) {
  if (rule.kind === 'created') return rule.text.replace('{}', () => `${det[rule.field]}`);
  if (rule.kind === 'lookup') {
    const call = (record.gateEvents ?? []).find((g) => g.decision.call.tool === rule.tool && g.decision.verdict === 'ALLOW');
    const ref = call?.decision.call.params?.[rule.param];
    return `${ref ? `${rule.noun} ${ref}` : rule.noun} · ${words(det.summary)}`;
  }
  if (rule.kind === 'answer') {
    const slot = rule.topicSlot;
    const topic = slot ? record.slots?.[slot]?.display ?? prevSlots?.[slot]?.display ?? null : null;
    return `answered: ${topic ?? words(det[rule.field])}`;
  }
  return `${prev} · ${rule.text}`;
}

/**
 * The key fact a turn established for the task it served, from its own audit drafts (so live and
 * replay agree), by the app's fact rules (ConsoleMeta.facts): a record created, a record looked up
 * and what it said, a topic answered. `prev` is the fact already held for the task, which a
 * downstream service's answer may add to.
 */
function factOf(record, prevSlots, prev) {
  const drafts = record.audit ?? [];
  let fact = null;
  for (const d of drafts) {
    const det = d.detail ?? {};
    const rule = META.facts.find((r) => ruleFits(r, d, det, prev));
    if (rule) fact = ruleFact(rule, record, prevSlots, prev, det);
  }
  return fact;
}

/**
 * The form a check ended on this turn, from its `form_stopped` audit draft (core/audit.ts), as the
 * NOW panel says it: "stopped: checkOwner, not-owner". Null on every other turn.
 */
function stoppedOf(drafts) {
  const d = (drafts ?? []).find((x) => x.type === 'form_stopped');
  if (!d) return null;
  const det = d.detail ?? {};
  return `stopped: ${det.action}${det.reason ? `, ${det.reason}` : ''}`;
}

function emptyNow() {
  return { state: 'idle', form: null, label: null, chips: [], asking: null, queued: [], completedLabel: null, fact: null, handoff: null };
}

/** Everything one call accumulates; a second `call_started` starts from this again. */
function emptyView() {
  return {
    status: 'waiting for a call', callSid: null, turnCount: 0,
    totals: { askMs: 0, tokens: 0, usd: 0, p50AskMs: 0 },
    lines: [], form: null, chips: chipsOf(null, null, null), pending: null, queued: [], asking: null,
    jev: { header: 'Jev', pending: false, groups: [], decision: '' },
    thresholds: {},
    channel: null, caller: null, level: 0,
    turnsView: [], gate: null, gateIsCurrent: false, source: null, auditTail: [], handoff: null,
    perceptionDiscarded: false,
    now: emptyNow(),
  };
}

/**
 * Folds an event list into the view the page renders. `opts.fromTrace` reconstructs the audit
 * tail from each record's own `audit` drafts (see pushAuditDrafts) instead of leaving it empty --
 * page.html passes it only in replay, where no real `audit` bus event will ever arrive.
 */
export function reduce(events, opts) {
  const fromTrace = opts?.fromTrace === true;
  const v = emptyView();
  let from = null;
  let ended = false;
  let prevSlots = null;
  /** The last turn whose batch reached the model, for the header of a turn that asked nothing. */
  let lastConsult = null;
  /** The previous event's clock, for how long a silence lasted. */
  let prevAt = null;
  /** Each consulted turn's ask time, for the header's median. */
  let asks = [];
  /** The NOW panel's inputs: the latest acting turn's task, the forms completed, each task's key fact, the transfer. */
  let task = null;
  let completed = [];
  let facts = new Map();
  let factForm = null;
  let transfer = null;
  /** Delivery facts of the kinds shown under no line (DELIVERY_NOTES `on: null`), by kind, each with the `turn` events seen when it came. */
  let held = new Map();
  let turnsSeen = 0;
  /**
   * The action webhook publishes `ended{hangup}` before a reconnect is known, so anything that
   * only a live call produces takes the status back.
   */
  const live = () => {
    if (!ended) return;
    ended = false;
    v.status = from === null ? 'live' : `live · ${from}`;
  };
  for (const e of events) {
    const at = typeof e.at === 'number' ? e.at : null;
    switch (e.type) {
      case 'call_started':
        // The page follows one call at a time: a second `call_started` is a new call,
        // and every total, line and panel starts over rather than continuing the last one's.
        Object.assign(v, emptyView());
        prevSlots = null;
        lastConsult = null;
        asks = [];
        task = null;
        completed = [];
        facts = new Map();
        factForm = null;
        transfer = null;
        held = new Map();
        turnsSeen = 0;
        from = e.from;
        ended = true; // so `live()` sets the status from one place
        live();
        v.callSid = e.callSid;
        v.thresholds = e.thresholds ?? {};
        v.channel = e.channel ?? null;
        v.caller = e.caller ?? null;
        // A view has a locale only once a turn of a call that speaks one says so (below), and a
        // configuration hash only once a turn of an app built from a folder names one.
        delete v.locale;
        delete v.configHash;
        delete v.answeredBy;
        break;
      case 'asked': {
        live();
        const rows = decisiveRows(null, v.thresholds, [], e.questions, e.turnState?.activeForm ?? null);
        v.jev = {
          header: `Jev · turn ${e.turnIndex} · ${Object.keys(e.questions ?? {}).length} questions · asking…`,
          pending: true,
          groups: groupRows(rows, slotsOf(e.turnState?.activeForm ?? null), e.turnState?.pendingConfirmation ?? null),
          decision: '',
        };
        break;
      }
      case 'turn': {
        const r = e.record;
        turnsSeen += 1;
        // The language the session speaks, which only an app that declares locales records.
        if (typeof r.locale === 'string') v.locale = r.locale;
        // The configuration the call runs under, which only an app with hashes (App.configHashes) records.
        if (typeof r.configHash === 'string') v.configHash = r.configHash;
        // What answers the call (TraceRecord.answeredBy), on the session start of a call a model answers.
        if (r.answeredBy && typeof r.answeredBy.model === 'string') v.answeredBy = { ...r.answeredBy };
        const consulted = r.questions !== null && r.questions !== undefined;
        // An interrupt or a relay error resolves to `ignore`: the record repeats the last turn's
        // index, says nothing, and asks for nothing. It must not be counted as a turn or blank
        // the Jev panel; only its frame shows, as a marker.
        const acted = r.decision.kind !== 'ignore' && r.decision.kind !== 'hold';
        const ev = r.event;
        if (ev && (ev.type === 'user.speech' || ev.type === 'user.text')) v.lines.push({ kind: 'caller', text: ev.text, turn: r.turnIndex });
        else if (ev && ev.type === 'channel.error') v.lines.push({ kind: 'marker', text: 'relay error', turn: r.turnIndex });
        else if (ev && ev.type === 'auth.signed_in') {
          // The portal's sign-in, not anything said: a marker, and the channel line names who signed in.
          v.lines.push({ kind: 'marker', text: META.signIn.marker, turn: r.turnIndex });
          if (ev.principal && ev.principal.first) v.caller = META.signIn.role ? `${ev.principal.first}, ${META.signIn.role}` : ev.principal.first;
        }
        // The batch went out and came back empty: say so between the caller and what the system
        // fell back to, or the panel is 32 blank bars with no explanation.
        if (consulted && r.error) v.lines.push({ kind: 'marker', text: `model error · ${r.error.name}`, turn: r.turnIndex });
        if (e.spoken) v.lines.push({ kind: 'system', text: e.spoken, promptId: r.decision.promptId ?? r.decision.kind, turn: r.turnIndex });
        if (!consulted && !acted) break;
        live();
        // The console's per-turn stage row and the level badge. A verification this turn
        // wins: its `identity` audit draft carries the level it left the caller at, which is what
        // a keypad code step (no `turnState`: nothing was asked of the model) would otherwise show
        // one turn late. Otherwise the level is the one the model saw this turn, and a non-model
        // turn (a keypad digit, a silence) holds the last one seen.
        const verified = levelOf(r.audit);
        if (verified !== null) v.level = verified;
        else if (r.turnState) v.level = r.turnState.caller.level;
        v.turnsView.push({
          turnIndex: r.turnIndex, said: e.spoken || null, input: ev?.type ?? null, stages: stagesOf(r, consulted, filledSlots(r.slots, prevSlots)),
          service: ev?.type === 'service.result' ? serviceNoteView(ev) : null,
        });
        const gateEvents = r.gateEvents ?? [];
        const lastGate = gateEvents[gateEvents.length - 1];
        // Whether the turn on screen made a call of its own: a quarantined turn or one that only
        // asked a question makes none, and the gate card keeps showing the last one, dimmed.
        v.gateIsCurrent = gateEvents.length > 0;
        if (lastGate) v.gate = gateViewOf(lastGate, r.turnIndex);
        // The perception pane's own read of this turn: discarded (nothing acted on it) once the
        // screen quarantines a turn, same signal `screenStage`/`perceptionStage` draw the strip from.
        v.perceptionDiscarded = !!r.quarantined;
        // Replay only (see the doc comment on `reduce`): the record's own drafts, not a real
        // audit event, so the row cannot assert a seq or a hash it was never actually chained with.
        if (fromTrace && r.audit && r.audit.length) pushAuditDrafts(v, r.audit);
        if (r.kb) v.source = sourceOf(r.kb);
        if (r.decision.kind === 'handoff') v.handoff = { reason: r.decision.reason, summary: null, summaryPending: true, summaryDemo: false, packet: packetOf(r.decision.slots) };
        // `turnIndex` is already 1-based (the greeting is turn 1) and repeats on an ignored turn.
        v.turnCount = Math.max(v.turnCount, r.turnIndex);
        v.form = r.form;
        const changed = changedSlots(r.slots, prevSlots);
        v.chips = chipsOf(r.slots, prevSlots, r.form);
        // The NOW panel: read before `prevSlots` moves on, since a completed form's slots are
        // already cleared on the turn that answers it and the topic it answered is only in the last.
        if (Array.isArray(r.completed)) completed = r.completed;
        const factKey = r.form ?? r.turnState?.activeForm ?? factForm;
        const fact = factOf(r, prevSlots, facts.get(factKey) ?? null);
        if (fact && factKey) { facts.set(factKey, fact); factForm = factKey; }
        task = {
          form: r.form ?? null,
          chips: nowChipsOf(r.slots, r.form ?? null, r.promptedFor ?? null, v.level),
          asking: nowAskingOf(r, v.thresholds),
          queued: (r.queued ?? []).map((f) => formLabel(f).toLowerCase()),
          stopped: stoppedOf(r.audit),
        };
        prevSlots = r.slots;
        v.pending = pendingLine(r.pendingConfirmation);
        v.queued = r.queued ?? [];
        v.asking = askingLine(r, v.thresholds);
        v.totals.askMs += r.timing?.askMs ?? 0;
        v.totals.tokens += tokensOf(r.usage);
        v.totals.usd += r.usage?.costUsd ?? 0;
        const decision = decisionLine(r, changed);
        if (consulted) {
          // Both the tick the intent row draws and the groups belong to the batch, so they read
          // the state it was asked under: `turnState`. The post-turn `pendingConfirmation` is one
          // turn out -- not yet set on the turn that speaks the summary, and already cleared on
          // the turn the caller answers it, which is the turn whose confirmation rows matter.
          const askedUnder = r.turnState ?? null;
          const rows = decisiveRows(r.answers, v.thresholds, r.gates, r.questions, askedUnder?.activeForm ?? null);
          const header = [
            `Jev · turn ${r.turnIndex}`,
            `${Object.keys(r.questions).length} questions`,
            `${Math.round(r.timing?.askMs ?? 0)} ms`,
            `${tokensOf(r.usage).toLocaleString('en-US')} tokens`,
            money(r.usage?.costUsd ?? 0),
          ].join(' · ') + (r.error ? ` · error: ${r.error.name}` : '');
          // A record with a `turnState` answers this outright, including with a null: falling back
          // to the post-turn state when it says "nothing was pending" would put the group back on
          // the very turn that has no answer to group.
          const pending = askedUnder ? askedUnder.pendingConfirmation ?? null : r.pendingConfirmation ?? null;
          v.jev = { header, pending: false, groups: groupRows(rows, slotsOf(r.form), pending), decision };
          lastConsult = r.turnIndex;
          asks.push(r.timing?.askMs ?? 0);
          v.totals.p50AskMs = median(asks);
        } else {
          // A turn nobody asked the model about (a silence, a keypad digit) must not blank the
          // column: the last consultation stays on screen and the header says which turn it was.
          const last = lastConsult === null ? '' : ` (last: turn ${lastConsult})`;
          v.jev = { header: `Jev · turn ${r.turnIndex} · no questions${last}`, pending: false, groups: v.jev.groups, decision };
        }
        break;
      }
      case 'silence': {
        // How long the caller was quiet, when both clocks are known.
        const quiet = at !== null && prevAt !== null && at >= prevAt ? Math.round((at - prevAt) / 1_000) : null;
        v.lines.push({ kind: 'marker', text: quiet === null ? 'silence' : `silence · ${quiet} s` });
        break;
      }
      case 'dtmf':
        v.lines.push({ kind: 'marker', text: `keypad ${e.digit}` });
        break;
      case 'interrupt':
        v.lines.push({ kind: 'marker', text: 'interrupted' });
        break;
      case 'reconnect':
        live();
        v.lines.push({ kind: 'marker', text: `reconnected (${e.attempt})` });
        break;
      case 'handoff': {
        // A labelled row of its own, and the NOW panel's handoff state (with the number, once known).
        transfer = { number: shownNumber(e.number), reason: e.reason };
        const to = transfer.number ? `to ${transfer.number}` : 'to a person';
        v.lines.push({ kind: 'handoff', text: `${to} · ${handoffReasonText(e.reason)}` });
        break;
      }
      case 'ended':
        ended = true;
        v.status = `ended · ${e.reason}`;
        break;
      case 'audit':
        // Live only: `replayEvents` never synthesizes this event (the audit log is not written to
        // the trace), so a replayed call's tail is built from `r.audit` instead, above, when
        // `opts.fromTrace` asks for that.
        pushAudit(v, e.entries);
        break;
      case 'handoff_summary':
        // The `turn` event whose decision was the handoff always precedes this one (see
        // events.ts's ordering note), so `v.handoff` is already set; a summary with no handoff
        // card to attach to (a stray or reordered event) is dropped rather than fabricating one.
        if (v.handoff) v.handoff = { ...v.handoff, summary: e.text, summaryPending: false, summaryDemo: e.demo === true };
        break;
      case 'delivery':
        addDeliveryNote(v.lines, e.fact, held, turnsSeen);
        // Not a moment the caller acted in: a silence is still measured from the turn before it.
        continue;
    }
    prevAt = at ?? prevAt;
  }
  // Merge consecutive keypad markers into one ("keypad 04121985"). A caller who starts keying while
  // the prompt still plays barges in on the first digit, so an "interrupted" marker lands inside the
  // entry: it is said once, ahead of the entry, and the digits stay one entry.
  const isKey = (l) => !!l && l.kind === 'marker' && /^keypad /.test(l.text);
  const merged = [];
  for (const l of v.lines) {
    const last = merged[merged.length - 1];
    const before = merged[merged.length - 2];
    if (isKey(l) && isKey(last)) {
      last.text += l.text.slice('keypad '.length);
    } else if (isKey(l) && last && last.kind === 'marker' && last.text === 'interrupted' && isKey(before)) {
      merged.splice(merged.length - 2, 2, last, { ...before, text: before.text + l.text.slice('keypad '.length) });
    } else {
      merged.push({ ...l });
    }
  }
  v.lines = merged;
  v.now = nowOf(v, task, completed, facts, transfer);
  return v;
}

/**
 * Puts a delivery fact's note (DELIVERY_NOTES) under the line it concerns: the agent line of the fact's
 * `turn` when it names one, else the latest agent line, or the latest caller line, in `lines` as they
 * stand. A fact arrives after the line it is about (a re-send once the line was cut, the join once the
 * joined turn ran), and before the next one is said: the adapter writes it so (server/adapter.ts), and
 * replay keeps that order (replayEvents). A note that replaces another kind takes its place on the line;
 * one for a line never said marks it so. A kind shown under no line is held, for the notes up to the
 * end of the next turn to read.
 */
function addDeliveryNote(lines, fact, held, turnsSeen) {
  const kind = fact?.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(DELIVERY_NOTES, kind)) return;
  if (!DELIVERY_NOTES[kind].on) {
    held.set(kind, { fact, turnsSeen });
    return;
  }
  const recent = {};
  for (const [k, h] of held) if (turnsSeen - h.turnsSeen <= 1) recent[k] = h.fact;
  const note = deliveryNote(fact, recent);
  if (!note) return;
  const want = note.on === 'agent' ? 'system' : 'caller';
  const turn = note.on === 'agent' && typeof fact.turn === 'number' ? fact.turn : null;
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) {
    if (lines[i].kind === want && (turn === null || lines[i].turn === turn)) at = i;
  }
  if (at < 0 && turn !== null) for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (lines[i].kind === want) at = i;
  if (at < 0) return;
  const line = lines[at];
  const kept = (line.notes ?? []).filter((n) => !note.replaces.includes(n.kind));
  lines[at] = { ...line, notes: [...kept, { kind: note.kind, text: note.text }], ...(note.unsaid ? { unsaid: true } : {}) };
}

/**
 * The NOW panel (what the agent is working on this moment): a handoff wins over everything, then
 * the open task, then the last task completed on the call, else waiting for a request.
 */
function nowOf(v, task, completed, facts, transfer) {
  const now = emptyNow();
  const form = task?.form ?? null;
  const done = completed.length ? [...new Set(completed.map(formLabel))].join(', ') : null;
  now.completedLabel = done;
  now.queued = task?.queued ?? [];
  // A check ended the form on the latest turn (only then is the field there at all).
  if (task?.stopped) now.stopped = task.stopped;
  if (v.handoff || transfer) {
    const reason = v.handoff?.reason ?? transfer.reason;
    now.state = 'handoff';
    now.form = form;
    now.label = form ? formLabel(form) : null;
    now.handoff = { number: transfer?.number ?? null, reason, reasonText: handoffReasonText(reason) };
    return now;
  }
  if (form) {
    now.state = 'task';
    now.form = form;
    now.label = formLabel(form);
    now.chips = task.chips;
    now.asking = task.asking;
    now.fact = facts.get(form) ?? null;
    return now;
  }
  // A confirmation of what the caller asked for can be out with no form open yet.
  now.asking = task?.asking ?? null;
  if (done) {
    now.state = 'completed';
    now.fact = facts.get(completed.at(-1)) ?? null;
  }
  return now;
}

/** The `reasonCode` an out `end` frame carries, read as the action webhook reads it (src/server/http.ts). */
function reasonCodeOf(handoffData) {
  try {
    const d = JSON.parse(String(handoffData ?? ''));
    return d && typeof d.reasonCode === 'string' ? d.reasonCode : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Live order among events sharing a timestamp: the inbound frame, then the turn it caused (with
 * its own `asked` immediately before it), then the end of the call.
 */
const REPLAY_RANK = {
  silence: 0, dtmf: 0, interrupt: 0, reconnect: 0,
  asked: 1, turn: 1,
  delivery: 1.5,
  handoff: 2, ended: 2,
};

/**
 * Where a delivery fact sorts among events sharing its timestamp: the carrier's interrupt with the
 * interrupt it is (ahead of the turn it causes); any other after the turn whose line it is about.
 */
function replayRank(e) {
  if (e.type === 'delivery') return e.fact?.kind === 'interrupt' ? 0 : REPLAY_RANK.delivery;
  return REPLAY_RANK[e.type] ?? 1;
}

/**
 * Rebuilds the live event sequence from a trace file and its frame log, so the page has one
 * renderer and two sources. `records` are what `/dashboard/traces/<sid>` returns: redacted, each
 * with the `spokenText` the caller heard (the browser has no prompt manifest to render it from).
 * `opts.deliveries` are the call's delivery facts as that route read them from the frame log
 * (server/dashboard/delivery.ts deliveriesOf), the same `delivery` events the adapter published live.
 */
export function replayEvents(records, frames, opts) {
  const events = [];
  if (!records || !records.length) return events;
  const first = records[0];
  const callSid = first.sessionId;
  // The session's channel, as its call_started audit draft names it on the first record (the
  // engine's own chat says `chat`), or an app's chat that names its session by a prefix of its own
  // (ConsoleMeta.chatPrefixes) and hex. A call is named by its carrier.
  const chat = recordedChannel(first) === 'chat' || META.chatPrefixes.some((p) => String(callSid).startsWith(p) && /^[0-9a-f]+$/.test(String(callSid).slice(p.length)));
  events.push({
    type: 'call_started', callSid, at: Date.parse(first.ts),
    from: opts?.from ?? 'replay', todayIso: String(first.ts).slice(0, 10), thresholds: opts?.thresholds ?? {},
    channel: chat ? 'chat' : 'voice',
  });
  const lines = frames ?? [];
  // A caller hangup leaves no out `end` frame at all: the socket just closes, and the adapter logs
  // that (`socketClosed` in handleSocketClose). Only then does the close stand for the end.
  const hasEnd = lines.some((f) => f && f.dir === 'out' && (f.msg ?? {}).type === 'end');
  // The frame log records each resumed socket, not a counter; the attempt is its position.
  let resumed = 0;
  // The engine's own web chat logs its own wire (server/chat/socket.ts), opened by a `start`.
  const chatWire = lines.some((f) => f && f.dir === 'in' && (f.msg ?? {}).type === 'start' && typeof (f.msg ?? {}).v === 'number');
  // A frame log line's `line` is its line number in the file, for a skip report; not shown here.
  const frameEvents = lines.flatMap((f) => {
    const at = Date.parse(f.ts);
    const m = f.msg ?? {};
    if (chatWire) return chatFrameEvents(f.dir, m, callSid, at, opts, () => ++resumed);
    if (f.dir === 'in' && m.type === 'silence') return [{ type: 'silence', callSid, at, promptId: null }];
    if (f.dir === 'in' && m.type === 'dtmf') return [{ type: 'dtmf', callSid, at, digit: m.digit }];
    if (f.dir === 'in' && m.type === 'interrupt') return [{ type: 'interrupt', callSid, at, utteranceUntilInterrupt: m.utteranceUntilInterrupt ?? null }];
    if (f.dir === 'log' && m.resumed) return [{ type: 'reconnect', callSid, at, attempt: ++resumed }];
    if (f.dir === 'log' && m.socketClosed && !hasEnd) return [{ type: 'ended', callSid, at, reason: 'hangup' }];
    if (f.dir === 'out' && m.type === 'end') {
      const code = reasonCodeOf(m.handoffData);
      const out = [];
      // The number dialled is not in the trace (the adapter masks its own), so the page says only
      // that the call was transferred unless the caller passes one in.
      if (code !== 'completed') out.push({ type: 'handoff', callSid, at, reason: code, number: opts?.handoffNumber ?? '…' });
      out.push({ type: 'ended', callSid, at, reason: code === 'completed' ? 'completed' : 'handoff' });
      return out;
    }
    return [];
  });
  const turnEvents = (records ?? []).flatMap((r) => {
    const at = Date.parse(r.ts);
    const out = [];
    // Glued to its turn rather than dated `ts - askMs`: the page holds the asked state for the
    // narration beat anyway, so a timestamp of its own buys nothing and can reorder.
    if (r.questions) {
      out.push({ type: 'asked', callSid, at, turnIndex: r.turnIndex, questions: r.questions, turnState: r.turnState });
    }
    out.push({ type: 'turn', callSid, at, record: r, spoken: r.spokenText ?? '' });
    return out;
  });
  // A silence or dtmf frame precedes the turn it caused and an end frame follows it, all three
  // sharing a timestamp, so the sort breaks ties by that order (stable, so `asked` keeps its turn).
  // Deliveries after the frames, so an interrupt's fact follows the interrupt it shares a time and a rank with.
  const deliveries = (Array.isArray(opts?.deliveries) ? opts.deliveries : [])
    .filter((d) => d && d.type === 'delivery' && typeof d.at === 'number')
    .map((d) => ({ ...d, callSid }));
  const all = frameEvents.concat(deliveries, turnEvents).sort((a, b) => a.at - b.at || replayRank(a) - replayRank(b));
  return events.concat(all);
}

/** The channel a trace's session was on, as its call_started audit draft names it (core/audit.ts); null in a trace without one. */
function recordedChannel(record) {
  const started = Array.isArray(record?.audit) ? record.audit.find((a) => a && a.type === 'call_started') : undefined;
  const channel = started?.detail?.channel;
  return typeof channel === 'string' ? channel : null;
}

/** How the engine's chat logs a session's end (its `ended` log line), as the console says it. */
const CHAT_ENDED = { complete: 'completed', handoff: 'handoff', idle: 'abandoned' };

/**
 * The events one line of the engine chat's frame log stands for: a `start` that resumes is a
 * reconnect, a `transfer` names why the chat was handed over, and the `ended` log line says how it
 * ended. A dropped socket is not the end of a chat (the session waits for a resume), and its `end`
 * message carries no reason, so neither says anything here.
 */
function chatFrameEvents(dir, m, callSid, at, opts, attempt) {
  if (dir === 'in' && m.type === 'start' && m.resume) return [{ type: 'reconnect', callSid, at, attempt: attempt() }];
  if (dir === 'out' && m.type === 'transfer') return [{ type: 'handoff', callSid, at, reason: String(m.reason ?? 'unknown'), number: opts?.handoffNumber ?? '…' }];
  if (dir === 'log' && typeof m.ended === 'string') return [{ type: 'ended', callSid, at, reason: Object.hasOwn(CHAT_ENDED, m.ended) ? CHAT_ENDED[m.ended] : 'completed' }];
  return [];
}

/** The longest run name kept: enough to be descriptive, short enough for the picker. */
export const TRACE_NAME_MAX = 32;

/**
 * A run name as it is stored: trimmed, inner whitespace collapsed, at most TRACE_NAME_MAX
 * characters. Empty means no name (the call id shows again).
 */
export function cleanTraceName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, TRACE_NAME_MAX);
}

/**
 * One row of the Replay picker: the run's name when it has one, else the start of its call id, then
 * its start time (UTC, as the trace records it) and its turn count.
 */
export function traceLabel(row, name) {
  const sid = String(row?.callSid ?? '');
  const started = typeof row?.startedAt === 'string' ? row.startedAt : null;
  const time = started && started.length >= 16 ? started.slice(11, 16) : 'unknown';
  const who = cleanTraceName(name) || `${sid.slice(0, 10)}…`;
  return `${who} · ${time} · ${Number(row?.turns) || 0} turns`;
}

/**
 * "Replay this call": the trace to auto-select on switching from Live to Replay -- the most
 * recent one, which is the call that just ended or, if the dashboard is still live-following one,
 * that call's trace as recorded so far. `/dashboard/traces` already sorts newest first, so this is
 * just naming that row; null when there is nothing to replay yet.
 */
export function latestTrace(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * The presenter replay bar's position readout. "Turn 4 of 12" once the trace has turns to count;
 * a trace too short or too early for that (no turns landed yet, or none at all) falls back to the
 * raw step position, "event 17 of 58", rather than showing a turn count of zero out of something.
 */
export function positionText(turnCount, totalTurns, cursor, totalEvents) {
  if (totalTurns > 0 && turnCount > 0) return `Turn ${turnCount} of ${totalTurns}`;
  return `event ${cursor} of ${totalEvents}`;
}

/**
 * What the console says under the downstream service's name (ConsoleMeta.serviceNote; the service.result
 * event's note, from the service's client): the answer taken, refused and why, or never arrived, and
 * any text parts it carried, which are never read. `warn` when anything was refused or ignored, so
 * the defense is visible. An event from before notes were kept reads as answered or not from its
 * result alone.
 */
export function serviceNoteView(event) {
  const words = META.serviceNote;
  const reasons = words.reasons ?? {};
  const note = event?.note;
  if (!note) return { text: event?.result ? words.answered : 'no answer', warn: !event?.result };
  const why = (Object.hasOwn(reasons, note.reason ?? '') ? reasons[note.reason] : null) ?? note.reason ?? '';
  const n = Number(note.ignoredTextParts) || 0;
  const ignored = n > 0 ? `${n} text part${n === 1 ? '' : 's'} ignored: never read, never spoken` : '';
  if (note.outcome === 'answered') return { text: ignored ? `${words.answered} · ${ignored}` : words.answered, warn: n > 0 };
  if (note.outcome === 'refused') return { text: `answer refused: ${why}${ignored ? ` · ${ignored}` : ''}`, warn: true };
  return { text: `no answer: ${why}`, warn: true };
}

/**
 * The conversation as exchanges, newest first: what the agent said (the question), what came
 * back (the caller's words, keyed digits, a silence, the transfer), and `turn`, the turn that
 * handled what came back, whose stage strip the page draws under it. A caller's answer so sits
 * under the question it answers, and the reply it got opens the exchange above. The newest
 * exchange is the question now waiting, alone until it is answered.
 *
 * Grouped by exchange rather than by turn because the pane reads newest on top: a turn block
 * (words, strip, reply) put an answer above the question it answered once the blocks were stacked
 * the other way. Lines carry their turn index; markers (a keypad run, a silence) do not, so they
 * take the turn of the reply that closes them. A reply from a turn with no caller input (a downstream
 * service's answer) closes the exchange before it as that turn.
 */
export function exchanges(lines) {
  const blocks = [];
  const fresh = () => ({ turn: null, prompt: [], input: [] });
  let cur = fresh();
  const close = () => { if (cur.prompt.length || cur.input.length) blocks.push(cur); cur = fresh(); };
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  for (const l of lines ?? []) {
    const t = num(l.turn);
    if (l.kind === 'system') {
      const spokenBy = cur.prompt.length ? num(cur.prompt[cur.prompt.length - 1].turn) : null;
      if (cur.input.length) { cur.turn ??= t; close(); }
      else if (cur.prompt.length && t !== null && t !== spokenBy) { cur.turn = t; close(); }
      cur.prompt.push(l);
    } else {
      // A second caller turn with no reply between (the first was ignored): each gets its own exchange.
      if (l.kind === 'caller' && cur.input.some((x) => x.kind === 'caller' && x.turn !== l.turn)) close();
      if (l.kind === 'caller') cur.turn = t;
      cur.input.push(l);
    }
  }
  close();
  return blocks.reverse();
}

/**
 * The call as a script, oldest first: only what the caller said and what they heard, for
 * reading the whole call top to bottom. A keyed entry, a silence, an interruption and the transfer
 * stay in as small notes so the replies around them still make sense; relay errors, reconnects
 * and model errors are the console's business, not the conversation's. A caller line whose turn
 * the screen quarantined is flagged: it was heard but never acted on; one that held a one-time code
 * said aloud is flagged too: the digits were masked on arrival, before anything logged them.
 */
/** What a one-time code said aloud is replaced with on arrival (core/spokenCode.ts CODE_MASK). */
export const CODE_MASK = '[code]';

export function scriptOf(lines, turnsView) {
  const screened = new Set((turnsView ?? []).filter((t) => t.stages?.screen?.state === 'fail').map((t) => t.turnIndex));
  const out = [];
  for (const l of lines ?? []) {
    const notes = { ...(l.notes?.length ? { notes: l.notes } : {}), ...(l.unsaid ? { unsaid: true } : {}) };
    if (l.kind === 'caller') out.push({ who: 'caller', text: l.text, screened: screened.has(l.turn), codeMasked: l.text.includes(CODE_MASK), ...notes });
    else if (l.kind === 'system') out.push({ who: 'agent', text: l.text, ...notes });
    else if (l.kind === 'handoff') out.push({ who: 'handoff', text: l.text });
    else if (/^keypad /.test(l.text)) out.push({ who: 'keypad', text: l.text.slice('keypad '.length) });
    else if (/^silence\b/.test(l.text) || l.text === 'interrupted') out.push({ who: 'note', text: l.text });
  }
  return out;
}

/** A turn whose event was `type`: a keyed digit's own turn, or the barge-in's. */
function turnOf(e, type) {
  return !!e && e.type === 'turn' && e.record?.event?.type === type;
}

/** What can sit inside a keypad entry: keypresses, their turns, and the barge-in a first keypress over the prompt sets off (its event, and its own turn). */
function inEntry(e) {
  return !!e && (e.type === 'dtmf' || e.type === 'interrupt' || turnOf(e, 'user.key') || turnOf(e, 'user.interrupt'));
}

/** Part of an entry still being collected: anything inEntry except a digit's turn that answered it. */
function collecting(e) {
  return inEntry(e) && !(turnOf(e, 'user.key') && e.spoken);
}

/**
 * The replay positions a step (→ / ←) lands on. Each keyed digit is two events (the keypress and
 * its own silent turn), so stepping one at a time through an eight-digit identifier was sixteen
 * presses. A keypad entry is one step instead: from before its first digit to the turn that
 * answers it, whichever order the keypresses and their turns were recorded in. A wrong code and its
 * re-entry are still two steps: the turn that answered the first entry ends it. Play still shows
 * the digits land one by one. A delivery note is no step of its own: it lands with the step before
 * it. Always includes 0 and the end.
 */
export function replayStops(events) {
  const n = events?.length ?? 0;
  const stops = [0];
  for (let c = 1; c < n; c++) {
    const next = events[c];
    if (collecting(events[c - 1]) && inEntry(next)) continue;
    // A delivery note lands with the step before it: the line it is about, or the interrupt it is.
    if (next?.type === 'delivery') continue;
    stops.push(c);
  }
  if (n > 0) stops.push(n);
  return stops;
}

/** The stop `delta` steps from `cursor` (which need not be a stop itself), clamped to the ends. */
export function stepStop(stops, cursor, delta) {
  if (!stops.length) return 0;
  if (delta > 0) {
    let i = stops.findIndex((s) => s > cursor);
    if (i < 0) return stops[stops.length - 1];
    i = Math.min(stops.length - 1, i + delta - 1);
    return stops[i];
  }
  let i = -1;
  for (let k = stops.length - 1; k >= 0; k--) if (stops[k] < cursor) { i = k; break; }
  if (i < 0) return stops[0];
  return stops[Math.max(0, i + delta + 1)];
}

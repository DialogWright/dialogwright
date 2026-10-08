import type { AuditEntry } from '../audit/types';
import type { HandoffWording } from '../core/app/types';

/**
 * What the handoff note must get right, read straight from the call's audit entries. The model writes
 * the narrative lines around these; the Identity and Blocked lines are these facts, word for word, so a
 * refusal or an injection attempt can never be summarised away.
 */
export interface HandoffFacts {
  identity: string;
  blocked: string[];
  manipulationAttempts: number;
  /** One-time codes said aloud instead of keyed: masked on arrival, and each replaced by a new one. */
  codesSpoken: number;
  handoffReason: string | null;
  completed: string[];
  /**
   * The slots the caller never confirmed, by id, from the handoff row (HandoffData.unconfirmed `mark`
   * or `omit`). Absent when the row has none, so every other app's facts are as they were.
   */
  unconfirmed?: string[];
  /**
   * The records the call created, listed under the app's own key (HandoffWording.created.key),
   * after the fields above. Absent when the app names none.
   */
  readonly [created: string]: unknown;
}

/** The engine's words, where the app gives none (HandoffWording). */
const LEVEL_WORDS: Readonly<Record<number, string>> = {
  0: 'not verified',
  1: 'level 1',
  2: 'level 2',
};

/** A refusal in words by the gate's built-in reasons (src/gate/policy.ts). */
const BLOCK_WORDS: Readonly<Record<string, string>> = {
  scope: "not in the caller's scope",
  role: "not allowed for the caller's role",
  confirmation: 'values changed after the caller confirmed',
  minimization: 'fields not allowed for that agent',
  identity: 'identity not strong enough',
  'unknown-tool': 'action not on the approved list',
  'unknown-rule': 'policy names a rule the gate does not know',
};

/** The engine's handoff reasons (core/lifecycle.ts), in words. */
const HANDOFF_WORDS: Readonly<Record<string, string>> = {
  'live-agent': 'the caller asked for a person',
  frustrated: 'the caller was frustrated and accepted a transfer',
  'max-attempts': 'the agent could not understand after several tries',
  'system-failure': 'a system problem',
  identity: 'identity could not be verified',
  'needs-human': 'the request needs a specialist',
  security: 'repeated attempts to manipulate the assistant',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `table[key]` when the table has its own entry for it, else undefined. */
function own(table: Readonly<Record<string, string>> | undefined, key: string): string | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The facts, read from the call's audit entries, in the app's words (`w`; App.handoff). A principal
 * kind the app words as signed in at the start (HandoffWording.signedIn) takes that Identity line,
 * and its own words for a refusal where the app gives them.
 */
export function handoffFacts(entries: readonly AuditEntry[], w: HandoffWording = {}): HandoffFacts {
  let level = 0;
  let startedAs: string | null = null;
  const blocked: string[] = [];
  let manipulationAttempts = 0;
  let codesSpoken = 0;
  let handoffReason: string | null = null;
  let completed: string[] = [];
  let unconfirmed: string[] | null = null;
  const created: string[] = [];
  for (const e of entries) {
    const d = e.detail;
    const principal = str(d.principal);
    if (e.type === 'call_started' && principal !== null && own(w.signedIn, principal) !== undefined) startedAs = principal;
    if (e.type === 'identity' && d.pass === true && typeof d.level === 'number') level = Math.max(level, d.level);
    if (e.type === 'gate' && d.verdict === 'BLOCK') {
      const reason = str(d.reason) ?? 'refused';
      const words = (startedAs !== null ? own(w.blockedAs?.[startedAs], reason) : undefined) ?? own(w.blocked, reason) ?? own(BLOCK_WORDS, reason) ?? reason;
      blocked.push(`${str(d.call) ?? str(d.tool) ?? 'an action'}: ${words}`);
    }
    if (e.type === 'screen_fired') manipulationAttempts++;
    if (e.type === 'code_spoken') codesSpoken++;
    if (w.created && e.type === w.created.type && str(d[w.created.field])) created.push(d[w.created.field] as string);
    if (e.type === 'handoff') {
      const r = str(d.reason);
      handoffReason = r ? (own(w.reasons, r) ?? own(HANDOFF_WORDS, r) ?? r) : null;
      if (Array.isArray(d.completed)) completed = d.completed.filter((x): x is string => typeof x === 'string');
      unconfirmed = Array.isArray(d.unconfirmed) ? d.unconfirmed.filter((x): x is string => typeof x === 'string') : null;
    }
  }
  const levelWords = w.levels && Object.hasOwn(w.levels, level) ? w.levels[level] : LEVEL_WORDS[level];
  const identity = startedAs !== null ? own(w.signedIn, startedAs)! : levelWords ?? `level ${level}`;
  const facts: HandoffFacts = { identity, blocked, manipulationAttempts, codesSpoken, handoffReason, completed, ...(unconfirmed !== null ? { unconfirmed } : {}) };
  return w.created ? { ...facts, [w.created.key]: created } : facts;
}

const LABELS = ['Identity', 'Wanted', 'Done', 'Blocked', 'Next'] as const;

/** One label's text from the model's note, whether it came as separate lines or run together. */
function field(text: string, label: string): string | null {
  const others = LABELS.filter((l) => l !== label).join('|');
  const m = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\s*\\b(?:${others}):|$)`).exec(text);
  const v = m?.[1]?.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

/**
 * The note as the human agent reads it: five labelled lines, always in this order. Identity and
 * Blocked come from the facts; Wanted, Done and Next from the model, with a factual fallback when it
 * left one out.
 */
export function composeNote(f: HandoffFacts, modelText: string): string {
  // The same refusal asked for twice is one line with a count, in the order first seen.
  const counts = new Map<string, number>();
  for (const b of f.blocked) counts.set(b, (counts.get(b) ?? 0) + 1);
  const blockedParts = [...counts].map(([b, n]) => (n > 1 ? `${b} (${n} times)` : b));
  if (f.codesSpoken > 0) blockedParts.push(`one-time code said aloud, not accepted; a new code was sent${f.codesSpoken > 1 ? ` (${f.codesSpoken} times)` : ''}`);
  if (f.manipulationAttempts > 0) blockedParts.push(`attempt to manipulate the assistant detected${f.manipulationAttempts > 1 ? ` (${f.manipulationAttempts} times)` : ''}`);
  const done = field(modelText, 'Done') ?? (f.completed.length ? `completed ${f.completed.join(', ')}` : 'nothing completed');
  const check = f.unconfirmed !== undefined && f.unconfirmed.length > 0 ? `; check with the caller what they never confirmed: ${f.unconfirmed.join(', ')}` : '';
  const next = field(modelText, 'Next') ?? `${f.handoffReason ? `transferred because ${f.handoffReason}` : 'take over the call'}${check}`;
  return [
    `Identity: ${f.identity}`,
    `Wanted: ${field(modelText, 'Wanted') ?? 'not stated'}`,
    `Done: ${done}`,
    `Blocked: ${blockedParts.length ? blockedParts.join('; ') : 'none'}`,
    `Next: ${next}`,
  ].join('\n');
}

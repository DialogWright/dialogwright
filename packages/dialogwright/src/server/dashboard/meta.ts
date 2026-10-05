import { identityOf } from '../../core/app/lookup';
import type { App, ConsoleFact, ConsoleLink, ServiceNoteWording } from '../../core/app/types';

/**
 * Everything the console's page (page.html, view.js) knows about the app, as plain JSON: the app's
 * own console config (App.console) with the engine's defaults filled in, and what the engine reads
 * off the app itself (each form's slots, the identity factors, how a slot's value is shown). The
 * page is served with it inlined, and /dashboard/boot answers it too.
 */
export interface ConsoleMeta {
  brand: { name: string; mark: string; key: string };
  /** Each form's slots, in prompt order (App.forms). */
  formSlots: Record<string, string[]>;
  /** Every slot, in the order shown outside a form. */
  slotOrder: string[];
  /** The slots asked while the caller's identity is stepped up (App.identity.factorSlots). */
  stepUp: string[];
  /**
   * How the NOW panel shows a filled slot, from its spec: `last4` (redact last4: an identifier by
   * its last four), `verified` (handed over as verified: given or verified, never its value),
   * `recorded` (redacted to its length: the caller's own words), `value` (shown as said while its
   * value is written by code, SlotSpec.displayFrom: the value, "7625 Oak Hollow Lane", rather than the
   * words). A slot not listed shows its display.
   */
  chipStyle: Record<string, 'last4' | 'verified' | 'recorded' | 'value'>;
  formLabels: Record<string, string>;
  slotLabels: Record<string, string>;
  questionPrefixes: Record<string, string[]>;
  detectQuestions: string[];
  levels: [string, string, string];
  handoffReasons: Record<string, string>;
  facts: ConsoleFact[];
  goodAuditTypes: string[];
  serviceNote: ServiceNoteWording;
  signIn: { marker: string; role: string | null };
  chatPrefixes: string[];
  heardBy: string;
  links: ConsoleLink[];
}

/** The console's words where the app gives none. */
const NEUTRAL_LEVELS: [string, string, string] = ['anonymous', 'level 1', 'level 2'];

/**
 * The level badge's words where the app's console gives none: anonymous, then each level by the
 * name identity.yaml gives it (IdentityConfig.levelNames), else the engine's neutral words. A label
 * only: the badge is chosen by the principal's level, a number.
 */
function levelWords(app: App): [string, string, string] {
  const names = app.identity?.levelNames;
  return [NEUTRAL_LEVELS[0], names?.[1] ?? NEUTRAL_LEVELS[1], names?.[2] ?? NEUTRAL_LEVELS[2]];
}
const NEUTRAL_SERVICE_NOTE: ServiceNoteWording = { label: 'Downstream service', answered: 'answered', reasons: {} };

/** The default slot order: the identity factors, then each form's slots in turn, each once. */
function defaultSlotOrder(app: App): string[] {
  const seen = new Set<string>();
  for (const id of [...identityOf(app).factorSlots, ...Object.values(app.forms).flatMap((f) => f.slots)]) seen.add(id);
  return [...seen];
}

function chipStyleOf(app: App): ConsoleMeta['chipStyle'] {
  const out: ConsoleMeta['chipStyle'] = {};
  for (const [id, spec] of Object.entries(app.slots)) {
    if (spec.redact === 'last4') out[id] = 'last4';
    else if (spec.handoff === 'verified') out[id] = 'verified';
    else if (spec.redact === 'length') out[id] = 'recorded';
    else if (spec.displayFrom === 'said') out[id] = 'value';
  }
  return out;
}

export function consoleMetaOf(app: App): ConsoleMeta {
  const c = app.console ?? {};
  return {
    brand: { name: app.brand?.name ?? app.id, mark: app.brand?.mark ?? app.id.slice(0, 2).toUpperCase(), key: app.brand?.key ?? app.id },
    formSlots: Object.fromEntries(Object.entries(app.forms).map(([id, f]) => [id, [...f.slots]])),
    slotOrder: [...(c.slotOrder ?? defaultSlotOrder(app))],
    stepUp: [...identityOf(app).factorSlots],
    chipStyle: chipStyleOf(app),
    formLabels: { ...c.formLabels },
    slotLabels: { ...c.slotLabels },
    questionPrefixes: Object.fromEntries(Object.entries(c.questionPrefixes ?? {}).map(([k, v]) => [k, [...v]])),
    detectQuestions: [...(c.detectQuestions ?? [])],
    levels: c.levels ? [...c.levels] : levelWords(app),
    handoffReasons: { ...c.handoffReasons },
    facts: [...(c.facts ?? [])],
    goodAuditTypes: [...(c.goodAuditTypes ?? [])],
    serviceNote: c.serviceNote ? { ...c.serviceNote, reasons: { ...c.serviceNote.reasons } } : NEUTRAL_SERVICE_NOTE,
    signIn: c.signIn ? { ...c.signIn } : { marker: 'signed in · portal', role: null },
    chatPrefixes: [...(c.chatPrefixes ?? [])],
    heardBy: c.heardBy ?? 'the caller',
    links: [...(c.links ?? [])],
  };
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);

/** JSON safe to inline in a <script>: no `</script>`, and no line separators a JS parser would choke on. */
function inlineJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** What the server adds to the page beyond the app's metadata. */
export interface ConsolePageOptions {
  /** A Sign out button after the app's links (CONSOLE_AUTH=token). */
  signOut?: boolean;
}

/**
 * The console page with the app's metadata in it: `{{name}}` and `{{mark}}` (escaped), `{{links}}`
 * (one header button per line, then Sign out when `options.signOut`), and `{{meta}}` (the whole
 * ConsoleMeta, as a script literal).
 */
export function renderConsolePage(template: string, meta: ConsoleMeta, options: ConsolePageOptions = {}): string {
  const links = meta.links
    .map((l) => `    <button id="${escapeHtml(l.id)}" title="${escapeHtml(l.title)}">${escapeHtml(l.label)}</button>\n`)
    .join('')
    + (options.signOut ? '    <form method="post" action="/dashboard/logout" class="signout"><button type="submit" title="Sign this browser out of the console">Sign out</button></form>\n' : '');
  // Replaced by function, so a `$` in a value is never read as a replacement pattern.
  const name = escapeHtml(meta.brand.name);
  const mark = escapeHtml(meta.brand.mark);
  const json = inlineJson(meta);
  const values: Record<string, string> = { name, mark, links, meta: json };
  // One pass over the template, so a value that itself contains a placeholder (a brand named
  // "{{meta}}") is never read as one.
  return template.replace(/\{\{(name|mark|links|meta)\}\}/g, (_m, key: string) => values[key]!);
}

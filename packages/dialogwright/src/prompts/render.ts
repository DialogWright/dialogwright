import type { App } from '../core/app/types';
import type { Decision } from '../core/decision';
import { endAction, sayAction, transferAction, type Action, type Say, type SayPart } from '../channel/actions';
import { exactClipId, isPauseOnly, joinSpoken, lineOf, segmentTemplate, stripLeadingPause, ttsOnly, VAR, wordingOf } from './segments';
import { vocabularyClipId } from './clips';
import { speechLanguagesOf } from '../core/locale';
import { handoffDataSlots, handoffDataUnconfirmed } from '../handoff/data';
import { KB_ACCOUNT_VAR, KB_ANSWER_SOURCE } from '../render/config';

export interface PromptEntry {
  text: string;
  interruptible: boolean;
  /** A framed line's frame for its exact content (prompts.yaml's `exactText`; frameOf). */
  exactText?: string;
  /** The line's other wordings, said in turn (prompts.yaml's `variants`; each under its wordingId). */
  variants?: readonly string[];
}

export interface RenderContext {
  /** clip id → filename, from discoverClips */
  clips: Map<string, string>;
  /** absolute URL prefix the filename is appended to */
  audioBase: string;
}

/** The line every completed call ends on (a chat's own, goodbye_chat, where the decision names it: CompleteDecision.goodbyeId). */
const GOODBYE = 'goodbye';
/** The goodbye on a chat (core/turn.ts goodbye): itself the goodbye, as `goodbye` is. */
const GOODBYE_CHAT = 'goodbye_chat';

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt variable missing: ${name}`);
    return v;
  });
}

/**
 * The line `id` as `locale` says it, and whether that locale's own words are what was found. A
 * locale other than the app's default (App.locales) says a line from its own prompts where it has
 * it, and from the default's manifest where it does not; the default locale, a locale the app does
 * not have, and no locale at all read the manifest, as an app without locales always does.
 */
export function localePromptEntry(app: App, id: string, locale?: string): { entry: PromptEntry; localized: boolean } {
  // A wording past a line's first (`ack_intent.v2`, wordingId): that variant of the line as the locale
  // says it, or the line's own text where the locale gives it fewer (a switch of language mid-turn).
  const line = lineOf(id);
  if (line !== id) {
    const found = localePromptEntry(app, line, locale);
    const text = found.entry.variants?.[wordingOf(id) - 2];
    return { entry: { text: text ?? found.entry.text, interruptible: found.entry.interruptible }, localized: found.localized };
  }
  const own = locale === undefined || !app.locales || locale === app.locales.default ? undefined : app.locales.prompts[locale];
  if (own && Object.hasOwn(own, id)) return { entry: own[id]!, localized: true };
  const entry = Object.hasOwn(app.prompts.manifest, id) ? app.prompts.manifest[id] : undefined;
  if (!entry) throw new Error(`unknown prompt id: ${id}`);
  return { entry, localized: false };
}

/** How many wordings the line `id` has as `locale` says it: its text, and each of its `variants`. */
export function wordingsOf(app: App, id: string, locale?: string): number {
  return 1 + (localePromptEntry(app, id, locale).entry.variants?.length ?? 0);
}

/** The line `id` as `locale` says it (localePromptEntry); without a locale, the app's manifest's. */
export function promptEntry(app: App, id: string, locale?: string): PromptEntry {
  return localePromptEntry(app, id, locale).entry;
}

export function promptText(app: App, id: string, vars: Record<string, string>, locale?: string): string {
  return renderTemplate(frameOf(app, id, promptEntry(app, id, locale)), framedVars(app, id, vars));
}

/**
 * The template a line is said from: its `text`, unless it is a framed line with a frame of its own for
 * its exact content (prompts.yaml's `exactText`) and no span of it is worded on this saying, when it is
 * that frame. `worded`: the spans a renderer gave words for (the turn's, once every check passed); none
 * by default, so a line's fixed text (what is said with no renderer, on a fallback, a repeat or a
 * read-back word for word, and what the session keeps) is the exact frame. A line with no `exactText`
 * is its `text` either way, as it always was.
 */
export function frameOf(app: App, id: string, entry: PromptEntry, worded: Readonly<Record<string, string>> = {}): string {
  // Only a framed line (App.generated's spans) has a frame for its exact words: on any other line,
  // exactText (which check and validateApp refuse there) is never said.
  const framed = app.generated?.lines[id]?.spans !== undefined;
  return framed && entry.exactText !== undefined && Object.keys(worded).length === 0 ? entry.exactText : entry.text;
}

/**
 * A line's variables with each generated span of a framed line (prompts.yaml's `generate`) filled: by
 * `spans`' wording where it gives one (the renderer's, once every check passed), else by the span's
 * exact content (its `from` value), word for word. That exact content is the line's fixed text: what
 * is said with no renderer, on a fallback, a repeat or a read-back word for word. `vars` itself for
 * every line that is not framed. A span is the engine's variable: a value the code gave under its name
 * is not used.
 */
export function framedVars(app: App, id: string, vars: Record<string, string>, spans: Readonly<Record<string, string>> = {}): Record<string, string> {
  const framed = app.generated?.lines[id]?.spans;
  if (framed === undefined) return vars;
  const out = { ...vars };
  for (const [name, span] of Object.entries(framed)) {
    // A knowledge answer's wording (a span `from: answer`) stands for the passage alone: the topic's
    // account line, the caller's own data, is said after it as it is after the passage.
    const account = span.from === KB_ANSWER_SOURCE ? (vars[KB_ACCOUNT_VAR] ?? '') : '';
    const value = Object.hasOwn(spans, name) ? (account === '' ? spans[name] : `${spans[name]} ${account}`) : vars[span.from];
    if (value === undefined) delete out[name];
    else out[name] = value;
  }
  return out;
}

export function handoffPromptId(reason: string): string {
  return `handoff_${reason.replace(/-/g, '_')}`;
}

/**
 * The language a line in `locale` is said in (Say.lang), for an app that declares locales
 * (App.locales): the language the voice speaks that locale in (app.yaml voice.locales.<tag>.tts),
 * which is the locale's own tag unless the app names another; without a locale, the default's. It is
 * what a start document's languages are named by (server/http.ts connectOptions), so a text frame
 * names one of them. An app without locales gives its lines no language, so they map to the relay's
 * en-US text frames exactly as they always have: that is what keeps every golden of an app without
 * locales unchanged.
 */
export function lineLang(app: App, locale?: string): string | undefined {
  return app.locales ? speechLanguagesOf(app, locale ?? app.locales.default).tts : undefined;
}

/**
 * One prompt as a line: clips where they exist, TTS text otherwise, adjacent text merged. A line in
 * a locale's own words is spoken whole by TTS: the clips are recordings of the default locale's.
 */
export function promptSay(app: App, promptId: string, vars: Record<string, string>, interruptible: boolean, ctx?: RenderContext | null, locale?: string, spans?: Readonly<Record<string, string>>): Say {
  const { entry, localized } = localePromptEntry(app, promptId, locale);
  // A framed line: each span its exact content, or its wording where the renderer gives one; said from
  // its exact frame (`exactText`, its own clips) where it has one and no span is worded.
  const template = frameOf(app, promptId, entry, spans);
  const clipId = template === entry.text ? promptId : exactClipId(promptId);
  vars = framedVars(app, promptId, vars, spans);
  const segments = segmentTemplate(clipId, template);
  // A line that carries data is spoken whole by TTS, even when clips are on.
  const lang = lineLang(app, locale);
  if (!ctx || localized || ttsOnly(app, segments)) return sayAction([{ text: renderTemplate(template, vars) }], interruptible, lang);
  const parts: SayPart[] = [];
  let pieces: string[] = [];
  const flush = (): void => {
    if (pieces.length === 0) return;
    let text = joinSpoken(pieces);
    if (parts.at(-1) && 'audio' in parts.at(-1)!) text = stripLeadingPause(text);
    if (text) parts.push({ text });
    pieces = [];
  };
  const play = (file: string): void => {
    flush();
    parts.push({ audio: ctx.audioBase + file });
  };
  for (const s of segments) {
    if (s.kind === 'fixed') {
      const file = isPauseOnly(s.text) ? undefined : ctx.clips.get(s.id);
      if (file) play(file);
      else pieces.push(s.text);
      continue;
    }
    const value = vars[s.name];
    if (value === undefined) throw new Error(`prompt variable missing: ${s.name}`);
    const id = vocabularyClipId(app, s.name, value);
    const file = id ? ctx.clips.get(id) : undefined;
    if (file) play(file);
    else pieces.push(value);
  }
  flush();
  return sayAction(parts, interruptible, lang);
}

/**
 * What a line of a decision is for, as generated wording words it (render/): an acknowledgement before
 * the line, the line that asks (a prompt decision's own), the line a call ends on (a completion's, and
 * the goodbye), or the line a call is handed to a person on.
 */
export type LineRole = 'acknowledge' | 'ask' | 'close' | 'hand-off';

/** Which prompt a Say of decisionToActions says, with its variables and its role in the decision. */
export interface SaidLine {
  readonly promptId: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly role: LineRole;
  /** The decision asks for this line word for word (PromptDecision.exact). */
  readonly exact?: true;
}

const SAID_LINES = new WeakMap<Say, SaidLine>();

/**
 * The prompt a Say made by decisionToActions says (its id, variables and role), or undefined for any
 * other Say (a replay, a language switch's prefix). Held beside the action, never on it, so an action
 * and everything written from it (the trace, the wire) are exactly as they were.
 */
export function saidLineOf(say: Say): SaidLine | undefined {
  return SAID_LINES.get(say);
}

/** What a decision asks the channel to do, in order, its lines in `locale` (promptEntry). */
export function decisionToActions(app: App, decision: Decision, ctx?: RenderContext | null, locale?: string): Action[] {
  const sayAs = (role: LineRole, exact = false) => (id: string, vars: Record<string, string>, interruptible: boolean): Say => {
    const line = promptSay(app, id, vars, interruptible, ctx, locale);
    SAID_LINES.set(line, { promptId: id, vars, role, ...(exact ? { exact: true as const } : {}) });
    return line;
  };
  const ack = sayAs('acknowledge');
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [sayAction([{ text: decision.text }], true, lineLang(app, locale))];
    case 'prompt': {
      const actions: Action[] = decision.acks.map((a) => ack(a.promptId, a.vars, promptEntry(app, a.promptId, locale).interruptible));
      actions.push(sayAs('ask', decision.exact === true)(decision.promptId, decision.vars, promptEntry(app, decision.promptId, locale).interruptible));
      return actions;
    }
    case 'complete':
      // A barge-in on an ack here could cut the closing line before the end, so only a
      // prompt's acks read their own manifest flag; a terminal decision's acks stay non-interruptible.
      return [
        ...decision.acks.map((a) => ack(a.promptId, a.vars, false)),
        sayAs('close')(decision.promptId, decision.vars, false),
        ...(closesWithGoodbye(decision) ? [] : [sayAs('close')(decision.goodbyeId ?? GOODBYE, {}, false)]),
        endAction(decision.completed),
      ];
    case 'handoff':
      // Same reasoning as 'complete': the call is ending, so nothing here is interruptible. The
      // transfer carries what the app's handoff data option lets leave the engine (handoff/data.ts):
      // by default no identity factor, and a redacted slot only masked.
      // With `unconfirmed: omit` a value never confirmed is left out; with `mark` the transfer names it.
      const slots = handoffDataSlots(app, decision.slots, decision.unconfirmed);
      const transfer = transferAction(decision.reason, decision.completed, decision.queued, slots, handoffDataUnconfirmed(app, slots, decision.unconfirmed), decision.transfer);
      if (decision.unchecked !== undefined) transfer.unchecked = decision.unchecked.map((u) => ({ ...u }));
      return [
        ...decision.acks.map((a) => ack(a.promptId, a.vars, false)),
        sayAs('hand-off')(decision.promptId, {}, false),
        transfer,
      ];
  }
}

/**
 * The completion is itself the goodbye (the goodbye, or on a chat its own, goodbye_chat), or its line
 * says goodbye itself (`goodbye: false`, an ending outcome's or a completion's), so the goodbye is not
 * said a second time.
 */
function closesWithGoodbye(decision: Extract<Decision, { kind: 'complete' }>): boolean {
  return decision.goodbye === false || decision.promptId === GOODBYE || decision.promptId === GOODBYE_CHAT;
}

/**
 * What the caller hears, built straight from the app's manifest. Deriving this from the
 * rendered actions would couple session state to how a line is rendered (clips, parts), so
 * the text a later turn reasons about is defined here instead. In `locale` (promptEntry): a
 * session's lines are in its own (core/locale.ts localeOf).
 */
export function spokenText(app: App, decision: Decision, locale?: string): string {
  const text = (id: string, vars: Record<string, string>): string => promptText(app, id, vars, locale);
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return '';
    case 'replay':
      return decision.text;
    case 'prompt':
      return [...decision.acks.map((a) => text(a.promptId, a.vars)), text(decision.promptId, decision.vars)].join(' ');
    case 'complete':
      return [
        ...decision.acks.map((a) => text(a.promptId, a.vars)),
        text(decision.promptId, decision.vars),
        ...(closesWithGoodbye(decision) ? [] : [text(decision.goodbyeId ?? GOODBYE, {})]),
      ].join(' ');
    case 'handoff':
      return [...decision.acks.map((a) => text(a.promptId, a.vars)), text(decision.promptId, {})].join(' ');
  }
}

/** The spoken text of a decision, for the CLI. */
export function decisionText(app: App, decision: Decision, locale?: string): string {
  return spokenText(app, decision, locale);
}

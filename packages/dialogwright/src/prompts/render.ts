import type { App } from '../core/app/types';
import type { Decision } from '../core/decision';
import { endAction, sayAction, transferAction, type Action, type Say, type SayPart } from '../channel/actions';
import { isPauseOnly, joinSpoken, segmentTemplate, stripLeadingPause, ttsOnly, VAR } from './segments';
import { vocabularyClipId } from './clips';
import { speechLanguagesOf } from '../core/locale';
import { handoffDataSlots } from '../handoff/data';

export interface PromptEntry {
  text: string;
  interruptible: boolean;
}

export interface RenderContext {
  /** clip id → filename, from discoverClips */
  clips: Map<string, string>;
  /** absolute URL prefix the filename is appended to */
  audioBase: string;
}

/** The line every completed call ends on. */
const GOODBYE = 'goodbye';

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
  const own = locale === undefined || !app.locales || locale === app.locales.default ? undefined : app.locales.prompts[locale];
  if (own && Object.hasOwn(own, id)) return { entry: own[id]!, localized: true };
  const entry = Object.hasOwn(app.prompts.manifest, id) ? app.prompts.manifest[id] : undefined;
  if (!entry) throw new Error(`unknown prompt id: ${id}`);
  return { entry, localized: false };
}

/** The line `id` as `locale` says it (localePromptEntry); without a locale, the app's manifest's. */
export function promptEntry(app: App, id: string, locale?: string): PromptEntry {
  return localePromptEntry(app, id, locale).entry;
}

export function promptText(app: App, id: string, vars: Record<string, string>, locale?: string): string {
  return renderTemplate(promptEntry(app, id, locale).text, vars);
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
export function promptSay(app: App, promptId: string, vars: Record<string, string>, interruptible: boolean, ctx?: RenderContext | null, locale?: string): Say {
  const { entry, localized } = localePromptEntry(app, promptId, locale);
  const segments = segmentTemplate(promptId, entry.text);
  // A line that carries data is spoken whole by TTS, even when clips are on.
  const lang = lineLang(app, locale);
  if (!ctx || localized || ttsOnly(app, segments)) return sayAction([{ text: renderTemplate(entry.text, vars) }], interruptible, lang);
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

/** What a decision asks the channel to do, in order, its lines in `locale` (promptEntry). */
export function decisionToActions(app: App, decision: Decision, ctx?: RenderContext | null, locale?: string): Action[] {
  const say = (id: string, vars: Record<string, string>, interruptible: boolean): Say => promptSay(app, id, vars, interruptible, ctx, locale);
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [sayAction([{ text: decision.text }], true, lineLang(app, locale))];
    case 'prompt': {
      const actions: Action[] = decision.acks.map((a) => say(a.promptId, a.vars, promptEntry(app, a.promptId, locale).interruptible));
      actions.push(say(decision.promptId, decision.vars, promptEntry(app, decision.promptId, locale).interruptible));
      return actions;
    }
    case 'complete':
      // A barge-in on an ack here could cut the closing line before the end, so only a
      // prompt's acks read their own manifest flag; a terminal decision's acks stay non-interruptible.
      return [
        ...decision.acks.map((a) => say(a.promptId, a.vars, false)),
        say(decision.promptId, decision.vars, false),
        ...(closesWithGoodbye(decision) ? [] : [say(GOODBYE, {}, false)]),
        endAction(decision.completed),
      ];
    case 'handoff':
      // Same reasoning as 'complete': the call is ending, so nothing here is interruptible. The
      // transfer carries what the app's handoff data option lets leave the engine (handoff/data.ts):
      // by default no identity factor, and a redacted slot only masked.
      return [
        ...decision.acks.map((a) => say(a.promptId, a.vars, false)),
        say(decision.promptId, {}, false),
        transferAction(decision.reason, decision.completed, decision.queued, handoffDataSlots(app, decision.slots)),
      ];
  }
}

/** The completion is itself the goodbye, so it is not said a second time. */
function closesWithGoodbye(decision: Extract<Decision, { kind: 'complete' }>): boolean {
  return decision.promptId === GOODBYE;
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
        ...(closesWithGoodbye(decision) ? [] : [text(GOODBYE, {})]),
      ].join(' ');
    case 'handoff':
      return [...decision.acks.map((a) => text(a.promptId, a.vars)), text(decision.promptId, {})].join(' ');
  }
}

/** The spoken text of a decision, for the CLI. */
export function decisionText(app: App, decision: Decision, locale?: string): string {
  return spokenText(app, decision, locale);
}

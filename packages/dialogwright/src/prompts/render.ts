import type { App } from '../core/app/types';
import type { Decision } from '../core/decision';
import { endAction, sayAction, transferAction, type Action, type Say, type SayPart } from '../channel/actions';
import { isPauseOnly, joinSpoken, segmentTemplate, stripLeadingPause, ttsOnly, VAR } from './segments';
import { vocabularyClipId } from './clips';

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

export function promptEntry(app: App, id: string): PromptEntry {
  const entry = app.prompts.manifest[id];
  if (!entry) throw new Error(`unknown prompt id: ${id}`);
  return entry;
}

export function promptText(app: App, id: string, vars: Record<string, string>): string {
  return renderTemplate(promptEntry(app, id).text, vars);
}

export function handoffPromptId(reason: string): string {
  return `handoff_${reason.replace(/-/g, '_')}`;
}

/** One prompt as a line: clips where they exist, TTS text otherwise, adjacent text merged. */
export function promptSay(app: App, promptId: string, vars: Record<string, string>, interruptible: boolean, ctx?: RenderContext | null): Say {
  const segments = segmentTemplate(promptId, promptEntry(app, promptId).text);
  // A line that carries data is spoken whole by TTS, even when clips are on.
  if (!ctx || ttsOnly(app, segments)) return sayAction([{ text: promptText(app, promptId, vars) }], interruptible);
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
  return sayAction(parts, interruptible);
}

/** What a decision asks the channel to do, in order. */
export function decisionToActions(app: App, decision: Decision, ctx?: RenderContext | null): Action[] {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [sayAction([{ text: decision.text }], true)];
    case 'prompt': {
      const actions: Action[] = decision.acks.map((a) => promptSay(app, a.promptId, a.vars, promptEntry(app, a.promptId).interruptible, ctx));
      actions.push(promptSay(app, decision.promptId, decision.vars, promptEntry(app, decision.promptId).interruptible, ctx));
      return actions;
    }
    case 'complete':
      // A barge-in on an ack here could cut the closing line before the end, so only a
      // prompt's acks read their own manifest flag; a terminal decision's acks stay non-interruptible.
      return [
        ...decision.acks.map((a) => promptSay(app, a.promptId, a.vars, false, ctx)),
        promptSay(app, decision.promptId, decision.vars, false, ctx),
        ...(closesWithGoodbye(decision) ? [] : [promptSay(app, GOODBYE, {}, false, ctx)]),
        endAction(decision.completed),
      ];
    case 'handoff':
      // Same reasoning as 'complete': the call is ending, so nothing here is interruptible.
      return [
        ...decision.acks.map((a) => promptSay(app, a.promptId, a.vars, false, ctx)),
        promptSay(app, decision.promptId, {}, false, ctx),
        transferAction(decision.reason, decision.completed, decision.queued, decision.slots),
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
 * the text a later turn reasons about is defined here instead.
 */
export function spokenText(app: App, decision: Decision): string {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return '';
    case 'replay':
      return decision.text;
    case 'prompt':
      return [...decision.acks.map((a) => promptText(app, a.promptId, a.vars)), promptText(app, decision.promptId, decision.vars)].join(' ');
    case 'complete':
      return [
        ...decision.acks.map((a) => promptText(app, a.promptId, a.vars)),
        promptText(app, decision.promptId, decision.vars),
        ...(closesWithGoodbye(decision) ? [] : [promptText(app, GOODBYE, {})]),
      ].join(' ');
    case 'handoff':
      return [...decision.acks.map((a) => promptText(app, a.promptId, a.vars)), promptText(app, decision.promptId, {})].join(' ');
  }
}

/** The spoken text of a decision, for the CLI. */
export function decisionText(app: App, decision: Decision): string {
  return spokenText(app, decision);
}

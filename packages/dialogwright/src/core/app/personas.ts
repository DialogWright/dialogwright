import type { App, GeneratedLine, GeneratedWording, PersonaOverlay, PromptManifestEntry } from './types';

/**
 * Personas (App.personas): the app as one of its personas words it. personaApp gives the app with the
 * persona's overlay applied: each line it words has its text, other wordings and chat version in place of
 * the app's, every other field of the line kept (interruptible, its frame for exact words...) and marked as
 * the persona's (PromptManifestEntry.persona), so it is said by text-to-speech, never the app's clips; the
 * persona text and word budgets its generated wording is given (App.generated.style) and each span's budget
 * it names. Everything else (the policy, the forms, the slots, the tools, the identity) is the app's own
 * object. One object per app and value, made once, so a session resolves the same one every time.
 */

const made = new WeakMap<App, Map<string, App>>();

/** The app as the persona `value` words it: the app itself where it has no personas or `value` names none. */
export function personaApp(app: App, value: string | undefined): App {
  const personas = app.personas;
  if (personas === undefined || value === undefined || !Object.hasOwn(personas.overlays, value)) return app;
  let byValue = made.get(app);
  if (byValue === undefined) {
    byValue = new Map();
    made.set(app, byValue);
  }
  const found = byValue.get(value);
  if (found !== undefined) return found;
  const built = withOverlay(app, value, personas.overlays[value]!);
  byValue.set(value, built);
  return built;
}

/** The persona a session's call data picks (App.personas' `from`), or undefined: the app's own. */
export function personaOf(app: App, callData: Readonly<Record<string, string>> | undefined): string | undefined {
  const personas = app.personas;
  if (personas === undefined) return undefined;
  const value = callData?.[personas.from];
  return value !== undefined && Object.hasOwn(personas.overlays, value) ? value : undefined;
}

function withOverlay(app: App, value: string, overlay: PersonaOverlay): App {
  const manifest: Record<string, PromptManifestEntry> = { ...app.prompts.manifest };
  for (const [id, line] of Object.entries(overlay.prompts ?? {})) {
    const own = manifest[id];
    if (own === undefined) continue;
    const reworded = line.text !== undefined || line.variants !== undefined;
    manifest[id] = {
      ...own,
      ...(line.text !== undefined ? { text: line.text } : {}),
      ...(line.variants !== undefined ? { variants: [...line.variants] } : {}),
      ...(line.chat !== undefined ? { chat: line.chat } : {}),
      ...(reworded ? { persona: value } : {}),
    };
  }
  const generated = app.generated === undefined ? undefined : generatedWith(app.generated, overlay);
  return {
    ...app,
    prompts: { ...app.prompts, manifest },
    ...(generated !== undefined ? { generated } : {}),
  };
}

function generatedWith(g: GeneratedWording, overlay: PersonaOverlay): GeneratedWording {
  const style = overlay.style;
  const words = style?.words;
  const lines: Record<string, GeneratedLine> = { ...g.lines };
  for (const [id, spans] of Object.entries(overlay.spans ?? {})) {
    const line = lines[id];
    if (line?.spans === undefined) continue;
    const next = { ...line.spans };
    for (const [name, { words: budget }] of Object.entries(spans)) {
      const span = next[name];
      if (span === undefined) continue;
      // A budget the persona gives is the span's own: no longer sized to its passage.
      const { sizedToPassage: _sized, ...rest } = span;
      next[name] = { ...rest, words: budget };
    }
    lines[id] = { ...line, spans: next };
  }
  return {
    ...g,
    lines,
    style: {
      // One description in place of the app's (its list too, where it has one), or several said in turn
      // (RenderStyle.personas), the first of them the persona.
      ...(style?.persona !== undefined ? withoutPersonas(g.style) : g.style),
      ...(style?.persona !== undefined ? (typeof style.persona === 'string' ? { persona: style.persona } : { persona: style.persona[0]!, personas: [...style.persona] }) : {}),
      ...(words !== undefined
        ? {
            words: {
              voice: words.voice ?? g.style.words.voice,
              chat: words.chat ?? g.style.words.chat,
              ...(g.style.words.answer !== undefined ? { answer: g.style.words.answer } : {}),
            },
          }
        : {}),
    },
  };
}

/** A style without its list of descriptions said in turn: a persona's own description replaces them all. */
function withoutPersonas<T extends { readonly personas?: readonly string[] }>(style: T): Omit<T, 'personas'> {
  const { personas: _personas, ...rest } = style;
  return rest;
}

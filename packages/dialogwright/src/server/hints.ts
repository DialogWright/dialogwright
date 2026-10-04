import type { App } from '../core/app/types';

const NUMBER_WORDS = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double'];

/** Comma-separated vocabulary for the ConversationRelay `hints` attribute: the app's words (App.voice.hints), then the number words. */
export function buildHints(app?: App): string {
  return buildHintsFrom(app?.voice?.hints ?? []);
}

/** The `hints` attribute for `words` (a locale's own, voice.locales.<tag>.hints), then the number words. */
export function buildHintsFrom(words: readonly string[]): string {
  return [...words, ...NUMBER_WORDS].join(', ');
}

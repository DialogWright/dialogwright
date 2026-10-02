import type { App } from '../core/app/types';

const NUMBER_WORDS = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double'];

/** Comma-separated vocabulary for the ConversationRelay `hints` attribute: the app's words (App.voice.hints), then the number words. */
export function buildHints(app?: App): string {
  return [...(app?.voice?.hints ?? []), ...NUMBER_WORDS].join(', ');
}

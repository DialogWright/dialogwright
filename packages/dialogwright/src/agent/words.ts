/**
 * Whether words were said: what an agent's cited words are held to. The matcher lives in
 * core/extract/words.ts, where the slot library reads it too; it is re-exported here.
 */
export { wordsOf, hasWords, sameWords } from '../core/extract/words';

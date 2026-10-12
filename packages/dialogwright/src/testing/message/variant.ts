import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineApp } from '../../define/defineApp';
import type { App } from '../../core/app/types';
import { MESSAGE_DIR, messageCode } from './app';

/**
 * Variants of the message fixture for the engine's tests: a copy of its YAML, each file changed by its
 * function, built with the fixture's code. The fixture itself is never changed, so its own calls and
 * read-back pages stay as they are. `remove` deletes the copies (call it after the tests).
 */
export function messageVariants(): { variant(files: Record<string, (text: string) => string>): App; remove(): void } {
  const dirs: string[] = [];
  return {
    variant(files) {
      const dir = mkdtempSync(join(tmpdir(), 'dialogwright-message-'));
      dirs.push(dir);
      cpSync(MESSAGE_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
      for (const [file, change] of Object.entries(files)) writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
      return defineApp(dir, messageCode);
    },
    remove() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A change to a file: `from` replaced by `to`, which must be there. */
export const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

/** The fixture's read-back as it is written: a framed line, its summary a generated span. */
const FRAMED = `  confirm_take_message:
    text: "Okay, thanks! I'll make sure {recipient} hears that {caller}, on {phone}, called and left this message: {summary}. Shall I pass it on?"
    interruptible: true
    generate:
      summary:
        from: message
        goal: Summarize the caller's message in one sentence, in their own terms.
        words: 25
`;

/**
 * The read-back generated whole from the message (prompts.yaml's `mode: generative` with `from`), as the
 * fixture had it before the framed form: the model words the whole line, the recipient, the caller and
 * the number among its items, and summarizes the message; the checks and the drift check hold it to
 * saying the message as the caller's. `pnpm check` warns of it, pointing to the framed form; it stays a
 * choice an app may make, and this keeps that path covered.
 */
export const WHOLE_LINE: Record<string, (text: string) => string> = {
  'app.yaml': replace('id: message', 'id: message-whole'),
  'prompts.yaml': replace(FRAMED, `  confirm_take_message:
    text: "For {recipient}, from {caller}, call back on {phone}. Your message: {message}. Shall I pass it on?"
    interruptible: true
    mode: generative
    goal: Read back who the message is for, who it is from and the number to call, then a short summary of the message in your own words, and ask whether to pass it on.
    from: [message]
`),
};

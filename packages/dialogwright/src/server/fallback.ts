import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeXml, xmlResponse } from './voice/xml';
import { twilioProvider } from './voice/twilio';
import { telnyxProvider } from './voice/telnyx';
import type { VoiceProvider } from './voice/provider';

/**
 * `pnpm fallback --provider <twilio|telnyx> --number <E.164> [--message "..."] --out <file> [--force]`:
 * the document a carrier turns to when it cannot reach the server at all (a restart, a reboot, a
 * crash, a tunnel down), written to a file to host somewhere that stays up when this machine does not
 * (a static page on GitHub Pages or Cloudflare Pages, object storage). It apologizes and dials the
 * number, the carrier's own apologize-and-dial document (VoiceProvider.apologizeAndDialDocument) unless
 * `--message` says what to say instead. It prints where the file's URL goes in the carrier's console:
 * Twilio's number's "Primary handler fails" URL; Telnyx's TeXML application's fallback URL. It sends
 * nothing anywhere and reads no setting: the number is given on the command line.
 */

const PROVIDERS: Readonly<Record<string, VoiceProvider>> = { twilio: twilioProvider, telnyx: telnyxProvider };

/** Where each carrier takes the document's URL, as its console names it. */
const WHERE: Readonly<Record<string, readonly string[]>> = {
  twilio: [
    'Twilio: Phone Numbers > Manage > Active numbers > the number > Voice Configuration: "Primary handler fails",',
    'set to the URL, with HTTP POST. (A TwiML Bin there works too: paste the file\'s contents.)',
  ],
  telnyx: [
    'Telnyx: the TeXML application the number uses (Voice > TeXML Applications), its voice fallback URL',
    '(voice_fallback_url in the API), with the same method as its voice URL.',
  ],
};

/** An E.164 number: a plus and up to 15 digits, the first not 0. */
const E164 = /^\+[1-9]\d{1,14}$/;

/** The fallback document: the carrier's apology and dial to `number`, or `message` said instead of the apology. */
export function fallbackDocument(provider: 'twilio' | 'telnyx', number: string, message?: string): string {
  const p = PROVIDERS[provider]!;
  if (message === undefined) return p.apologizeAndDialDocument(number);
  // Both carriers' documents are the same shape: a Say, then a Dial (voice/twilio.ts, voice/telnyx.ts).
  return xmlResponse(`<Say>${escapeXml(message)}</Say><Dial>${escapeXml(number)}</Dial>`);
}

export const FALLBACK_USAGE = 'usage: pnpm fallback --provider <twilio|telnyx> --number <E.164> [--message "..."] --out <file> [--force]';

export interface FallbackIo {
  out(line: string): void;
  /** Where the command was run (pnpm's INIT_CWD), which a relative --out is from. */
  invokedFrom: string;
}

/** The command; returns its exit code (2 for a command line it does not understand). */
export async function main(argv: readonly string[], io: FallbackIo): Promise<number> {
  const flags: { provider?: string; number?: string; message?: string; out?: string; force: boolean } = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === '--force') flags.force = true;
    else if (a === '--provider' && v !== undefined) flags.provider = argv[++i];
    else if (a === '--number' && v !== undefined) flags.number = argv[++i];
    else if (a === '--message' && v !== undefined) flags.message = argv[++i];
    else if (a === '--out' && v !== undefined) flags.out = argv[++i];
    else {
      io.out(FALLBACK_USAGE);
      return 2;
    }
  }
  if (flags.provider === undefined || flags.number === undefined || flags.out === undefined) {
    io.out(FALLBACK_USAGE);
    return 2;
  }
  if (flags.provider !== 'twilio' && flags.provider !== 'telnyx') {
    io.out(`--provider must be twilio or telnyx, got "${flags.provider}"`);
    return 2;
  }
  if (!E164.test(flags.number)) {
    io.out(`--number must be an E.164 number like +15555550123, got "${flags.number}"`);
    return 2;
  }
  if (flags.message !== undefined && flags.message.trim() === '') {
    io.out('--message must say something: leave it out for the carrier\'s own apology');
    return 2;
  }
  const file = isAbsolute(flags.out) ? flags.out : resolve(io.invokedFrom, flags.out);
  if (existsSync(file) && !flags.force) {
    io.out(`${file} exists: pnpm fallback ... --force replaces it`);
    return 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  // A public document with no secret in it: an ordinary file.
  writeFileSync(file, fallbackDocument(flags.provider, flags.number, flags.message?.trim()), { mode: 0o644 });
  io.out(`wrote ${file}: says ${flags.message === undefined ? 'the carrier\'s apology' : 'your message'}, then dials ${flags.number}`);
  io.out('Host it at an https URL that is not on this machine (GitHub Pages, Cloudflare Pages, object storage), so it');
  io.out('answers when the server cannot, then paste that URL into the carrier\'s console:');
  for (const line of WHERE[flags.provider]!) io.out(`  ${line}`);
  io.out('A caller whose call the carrier cannot reach the server for then hears it and is put through. Set it again');
  io.out('whenever HANDOFF_NUMBER changes.');
  return 0;
}

// Run when invoked directly (tsx fallback.ts); importing it runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), { out: (line) => console.log(line), invokedFrom: process.env.INIT_CWD?.trim() || process.cwd() });
}

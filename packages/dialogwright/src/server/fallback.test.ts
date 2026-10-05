import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fallbackDocument, FALLBACK_USAGE, main } from './fallback';
import { twilioProvider } from './voice/twilio';
import { telnyxProvider } from './voice/telnyx';

/**
 * `pnpm fallback` (fallback.ts): the static document a carrier turns to when it cannot reach the server
 * (a restart, a reboot, a crash), which apologizes and dials the handoff number. Written to a file in a
 * temp folder; nothing is sent anywhere.
 */

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fallback-'));
  dirs.push(d);
  return d;
}

async function run(argv: string[], invokedFrom = temp()): Promise<{ code: number; out: string; dir: string }> {
  const lines: string[] = [];
  const code = await main(argv, { out: (l) => lines.push(l), invokedFrom });
  return { code, out: lines.join('\n'), dir: invokedFrom };
}

describe('the fallback document', () => {
  it("is each carrier's own apology and dial to the number, word for word, by default", () => {
    expect(fallbackDocument('twilio', '+15555550123')).toBe(twilioProvider.apologizeAndDialDocument('+15555550123'));
    expect(fallbackDocument('telnyx', '+15555550123')).toBe(telnyxProvider.apologizeAndDialDocument('+15555550123'));
    expect(fallbackDocument('twilio', '+15555550123')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>+15555550123</Dial></Response>',
    );
  });

  it('says a message of your own instead, escaped as XML', () => {
    const doc = fallbackDocument('telnyx', '+15555550123', 'We are back in a moment. <Hold> & "wait" for Pat\'s team.');
    expect(doc).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are back in a moment. &lt;Hold&gt; &amp; &quot;wait&quot; for Pat\'s team.</Say><Dial>+15555550123</Dial></Response>',
    );
  });
});

describe('pnpm fallback', () => {
  it('writes the document and says where its URL goes in the carrier\'s console, for Twilio', async () => {
    const r = await run(['--provider', 'twilio', '--number', '+15555550123', '--out', 'fallback.xml']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.dir, 'fallback.xml'), 'utf8')).toBe(fallbackDocument('twilio', '+15555550123'));
    expect(r.out).toContain(`wrote ${join(r.dir, 'fallback.xml')}`);
    expect(r.out).toContain('"Primary handler fails"');
    expect(r.out).toContain('not on this machine');
  });

  it('for Telnyx, with a message of its own', async () => {
    const r = await run(['--provider', 'telnyx', '--number', '+15555550123', '--message', 'One moment, please.', '--out', 'telnyx.xml']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.dir, 'telnyx.xml'), 'utf8')).toContain('<Say>One moment, please.</Say><Dial>+15555550123</Dial>');
    expect(r.out).toContain('TeXML application');
    expect(r.out).toContain('Webhook Failover URL');
  });

  it('refuses what it cannot write: a carrier it does not know, a number that is not E.164, an empty message, no --out', async () => {
    expect((await run(['--provider', 'other', '--number', '+15555550123', '--out', 'f.xml'])).out).toContain('--provider must be twilio or telnyx');
    expect((await run(['--provider', 'twilio', '--number', '555-0123', '--out', 'f.xml'])).out).toContain('--number must be an E.164 number like +15555550123, got "555-0123"');
    expect((await run(['--provider', 'twilio', '--number', '+15555550123', '--message', ' ', '--out', 'f.xml'])).code).toBe(2);
    const none = await run(['--provider', 'twilio', '--number', '+15555550123']);
    expect(none.code).toBe(2);
    expect(none.out).toBe(FALLBACK_USAGE);
    expect((await run(['--bogus'])).out).toBe(FALLBACK_USAGE);
  });

  it('refuses to replace a file without --force', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'fallback.xml'), 'mine');
    const argv = ['--provider', 'twilio', '--number', '+15555550123', '--out', 'fallback.xml'];
    const first = await run(argv, dir);
    expect(first.code).toBe(1);
    expect(first.out).toContain('exists: pnpm fallback ... --force replaces it');
    expect(readFileSync(join(dir, 'fallback.xml'), 'utf8')).toBe('mine');
    expect((await run([...argv, '--force'], dir)).code).toBe(0);
    expect(existsSync(join(dir, 'fallback.xml'))).toBe(true);
  });

  it('is a script at the repository root', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.fallback).toBe('tsx packages/dialogwright/src/server/fallback.ts');
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppFully } from './check';
import { formatProblem } from './problems';
import { CALLBACK_DIR, callbackApp, callbackCode } from '../testing/callback/app';
import { callDataProblems } from '../core/app/validate';

/**
 * What `check` says of app.yaml's `callData` and `startParameters`: it refuses a key with no `from`, a
 * source it does not read (an unknown prefix, a setup field the wire does not keep, an echo named as a
 * parameter), a key or parameter name that is not a plain word, a parameter that is not `env.<NAME>`
 * or that takes a name the engine writes. Business choices (which keys, how each is recorded) are the
 * app's.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function folder(change: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dialogwright-calldata-'));
  scratch.push(dir);
  cpSync(CALLBACK_DIR, dir, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  writeFileSync(join(dir, 'app.yaml'), change(readFileSync(join(dir, 'app.yaml'), 'utf8')));
  return dir;
}

async function problemsOf(change: (text: string) => string): Promise<string[]> {
  const r = await checkAppFully(folder(change), { code: callbackCode, fixturesRoot: PACKAGE_DIR });
  return r.problems.map(formatProblem);
}

const replace = (from: string, to: string) => (text: string): string => {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return text.replace(from, to);
};

describe('the fixture', () => {
  it('passes check with its callData', async () => {
    expect(await checkAppFully(CALLBACK_DIR, { code: callbackCode, fixturesRoot: PACKAGE_DIR })).toEqual({ problems: [], codeChecked: true });
  });

  it('builds App.callData in its order, redact only where written', () => {
    expect(callbackApp.callData).toEqual({
      queue: { from: 'param.queue', redact: 'keep' },
      accountRef: { from: 'param.accountRef', redact: 'last4' },
      forwardedFrom: { from: 'setup.forwardedFrom', redact: 'last4' },
      referral: { from: 'webhook.SipHeader_X-Referral' },
      page: { from: 'chat.page', redact: 'keep' },
    });
    expect(Object.keys(callbackApp.callData!)).toEqual(['queue', 'accountRef', 'forwardedFrom', 'referral', 'page']);
  });
});

describe('app.yaml callData', () => {
  it('refuses a key with no from', async () => {
    const problems = await problemsOf(replace('queue: { from: param.queue, redact: keep }', 'queue: { redact: keep }'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('callData.queue');
    expect(problems[0]).toContain('"from"');
  });

  it('refuses a source with an unknown prefix, or none', async () => {
    const unknown = await problemsOf(replace('from: param.queue', 'from: header.queue'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain('callData.queue.from');
    expect(unknown[0]).toContain('"header.queue" is not a source of call data: it must be one of param.<name>, setup.<name>, webhook.<name>, chat.<name>');
    expect(unknown[0]).toContain('->  write param.<name> for a custom parameter');
    const none = await problemsOf(replace('from: param.queue', 'from: queue'));
    expect(none[0]).toContain('"queue" is not a source of call data');
  });

  it('refuses a setup field the wire does not keep, and the numbers', async () => {
    const problems = await problemsOf(replace('from: setup.forwardedFrom', 'from: setup.callerZip'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"callerZip" is not a field of the setup frame the wire keeps');
    const from = await problemsOf(replace('from: setup.forwardedFrom', 'from: setup.from'));
    expect(from[0]).toContain('app.yaml\'s callerNumber');
  });

  it('refuses a name with a space or a quote in it, and an echo read as a parameter', async () => {
    const spaced = await problemsOf(replace('from: param.queue', 'from: "param.the queue"'));
    expect(spaced[0]).toContain('"the queue" is not a name a param source has');
    const echo = await problemsOf(replace('from: param.queue', 'from: param.dw_queue'));
    expect(echo[0]).toContain('the server\'s echoes of webhook fields');
    expect(echo[0]).toContain('webhook.<field>');
  });

  it('takes a carrier\'s own names, hyphens and dots included', async () => {
    expect(await problemsOf(replace('from: param.queue', 'from: param.queue-name.v2'))).toEqual([]);
  });

  it('refuses a key that is not a plain word', async () => {
    const problems = await problemsOf(replace('  queue: { from', '  queue-name: { from'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the key "queue-name" is not a valid id');
  });

  it('refuses a redaction that is not a mask', async () => {
    const problems = await problemsOf(replace('redact: keep }\n  accountRef', 'redact: hide }\n  accountRef'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('callData.queue.redact');
    expect(problems[0]).toContain('"last4", "mask", "length", "secret", "keep"');
  });
});

describe('app.yaml startParameters', () => {
  const add = (block: string) => (text: string): string => `${text}\n${block}\n`;

  it('takes env.<NAME> values', async () => {
    expect(await problemsOf(add('startParameters:\n  line: env.CALLBACK_LINE\n  site: env.SITE_2'))).toEqual([]);
  });

  it('refuses a value written in YAML', async () => {
    const problems = await problemsOf(add('startParameters:\n  line: "+15555550100"'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('startParameters.line');
    expect(problems[0]).toContain('is not an environment variable: it must be env.<NAME>');
    expect(problems[0]).toContain('a value is never written in YAML');
  });

  it('refuses a name that is not a plain word, and one the engine writes itself', async () => {
    expect((await problemsOf(add('startParameters:\n  line-1: env.LINE')))[0]).toContain('the key "line-1" is not a valid id');
    expect((await problemsOf(add('startParameters:\n  locale: env.LOCALE')))[0]).toContain('the custom parameter "locale" is the engine\'s own');
    expect((await problemsOf(add('startParameters:\n  dw_line: env.LINE')))[0]).toContain('the server\'s echoes of webhook fields');
  });
});

describe('validateApp (an app written in code)', () => {
  it('finds nothing wrong with the fixture\'s', () => {
    expect(callDataProblems(callbackApp)).toEqual([]);
  });

  it('says what is wrong with a key and a parameter', () => {
    expect(callDataProblems({
      callData: {
        'bad-key': { from: 'param.x' },
        nofrom: { from: '' },
        prefix: { from: 'header.x' },
        field: { from: 'setup.to' },
        masked: { from: 'param.y', redact: 'hidden' as never },
      },
      startParameters: { line: '+15555550100', locale: 'env.LOCALE' },
    })).toEqual([
      'callData key "bad-key" is not a plain word (letters, digits and underscores, starting with a letter)',
      'callData key "nofrom" has no from',
      'callData key "prefix": "header.x" is not a source of call data: it must be one of param.<name>, setup.<name>, webhook.<name>, chat.<name>',
      'callData key "field": "to" is not a field of the setup frame the wire keeps (callSid, sessionId, accountSid, parentCallSid, forwardedFrom, callType, callerName, direction, callStatus, callControlId, callSessionId, callLegId)',
      'callData key "masked" redact "hidden" is not one of last4, mask, length, secret, keep',
      'startParameters "line" is not env.<NAME>',
      'startParameters name "locale" is one the engine writes itself',
    ]);
  });
});

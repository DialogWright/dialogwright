import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { consoleExposure, describeConfig, loadConfig } from '../config';
import { consoleLinkFileOf, DEFAULT_CONSOLE_SESSION_HOURS, parseSessionKey } from './settings';

const base = { PUBLIC_HOST: 'demo.example.net', TWILIO_AUTH_TOKEN: 'tok', HANDOFF_NUMBER: '+15551234567' };

describe('CONSOLE_AUTH', () => {
  it('is local by default: the config has no consoleAuth, and says what it said before', () => {
    const c = loadConfig(base);
    expect(c.consoleAuth).toBeUndefined();
    expect('consoleAuth' in c).toBe(false);
    expect(describeConfig(c)).toContain('console local only');
    expect(loadConfig({ ...base, CONSOLE_AUTH: 'local' })).toEqual(c);
    // The token mode's own variables are not read in local mode.
    expect(loadConfig({ ...base, CONSOLE_SESSION_KEY: 'short', CONSOLE_SESSION_HOURS: 'x' })).toEqual(c);
  });

  it('refuses anything but local or token', () => {
    expect(() => loadConfig({ ...base, CONSOLE_AUTH: 'password' })).toThrow('CONSOLE_AUTH must be local or token, got "password"');
  });

  it('token: sessions of 12 hours, a key made at start, the link file beside the trace folder', () => {
    const c = loadConfig({ ...base, CONSOLE_AUTH: 'token' });
    expect(c.consoleAuth).toEqual({
      method: 'token',
      sessionKey: null,
      sessionHours: DEFAULT_CONSOLE_SESSION_HOURS,
      linkFile: join(dirname(resolve('traces')), '.console-link', 'link.json'),
      clientAddress: 'auto',
    });
    expect(DEFAULT_CONSOLE_SESSION_HOURS).toBe(12);
    expect(describeConfig(c)).toContain('console sign-in (CONSOLE_AUTH=token, sessions 12 h, key made at start)');
    expect(describeConfig(c)).not.toContain('console local only');
  });

  it('token: CONSOLE_SESSION_HOURS from 1 to 168', () => {
    expect(loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_SESSION_HOURS: '2' }).consoleAuth?.sessionHours).toBe(2);
    expect(loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_SESSION_HOURS: '168' }).consoleAuth?.sessionHours).toBe(168);
    for (const bad of ['0', '169', '1.5', '-1', 'a day']) {
      expect(() => loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_SESSION_HOURS: bad }), bad).toThrow(`CONSOLE_SESSION_HOURS must be a whole number of hours from 1 to 168, got "${bad}"`);
    }
  });

  it('token: CONSOLE_SESSION_KEY is 32 random bytes or more, hex or base64, and is never echoed', () => {
    const bytes = randomBytes(32);
    for (const written of [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')]) {
      const c = loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_SESSION_KEY: written });
      expect(c.consoleAuth?.sessionKey?.equals(bytes), written).toBe(true);
      expect(describeConfig(c)).toContain('key from CONSOLE_SESSION_KEY');
      expect(describeConfig(c)).not.toContain(written);
    }
    const tooShort = randomBytes(31).toString('hex');
    const repeated = 'ab'.repeat(32);
    const notAKey = 'correct horse battery staple, a phrase and not a key at all';
    for (const bad of [tooShort, repeated, notAKey]) {
      let message = '';
      try {
        loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_SESSION_KEY: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/^CONSOLE_SESSION_KEY must be at least 32 random bytes, written as hex or base64 \(openssl rand -hex 32\)/);
      expect(message).not.toContain(bad);
    }
  });

  it('token: CONSOLE_LINK_FILE names the link file, from where the server runs', () => {
    const c = loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_LINK_FILE: 'private/console.json' });
    expect(c.consoleAuth?.linkFile).toBe(resolve('private/console.json'));
    expect(consoleLinkFileOf({ TRACE_DIR: '/srv/dw/traces' }, '/elsewhere')).toBe('/srv/dw/.console-link/link.json');
    expect(consoleLinkFileOf({ CONSOLE_LINK_FILE: 'x/link.json' }, '/srv/app')).toBe('/srv/app/x/link.json');
    expect(consoleLinkFileOf({}, '/srv/app')).toBe('/srv/app/.console-link/link.json');
  });

  it('token: CONSOLE_CLIENT_ADDRESS says which header names a client\'s address, auto by default, and is checked', () => {
    for (const source of ['auto', 'cf-connecting-ip', 'x-forwarded-for', 'remote'] as const) {
      const c = loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_CLIENT_ADDRESS: source });
      expect(c.consoleAuth?.clientAddress).toBe(source);
      if (source === 'auto') expect(describeConfig(c)).not.toContain('addresses from');
      else expect(describeConfig(c)).toContain(`addresses from ${source}`);
    }
    expect(loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_CLIENT_ADDRESS: ' X-Forwarded-For ' }).consoleAuth?.clientAddress).toBe('x-forwarded-for');
    expect(() => loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_CLIENT_ADDRESS: 'x-real-ip' })).toThrow('CONSOLE_CLIENT_ADDRESS must be auto, cf-connecting-ip, x-forwarded-for or remote, got "x-real-ip"');
    // Not read in local mode.
    expect(loadConfig({ ...base, CONSOLE_CLIENT_ADDRESS: 'x-real-ip' })).toEqual(loadConfig(base));
  });

  it('token: refuses DASHBOARD=off, with nothing to sign in to', () => {
    expect(() => loadConfig({ ...base, CONSOLE_AUTH: 'token', DASHBOARD: 'off' })).toThrow('CONSOLE_AUTH=token signs in to the console, which DASHBOARD=off turns off: set DASHBOARD=on or CONSOLE_AUTH=local');
  });

  it('says where the console is reached at startup, and that an app\'s local-only pages stay local', () => {
    const c = loadConfig({ ...base, CONSOLE_AUTH: 'token' });
    expect(consoleExposure(c)).toBe('console: /dashboard behind sign-in on https://demo.example.net/dashboard (CONSOLE_AUTH=token); pnpm console:link prints a sign-in link');
    expect(consoleExposure(c, ['/dashboard', '/staff'])).toBe('console: /dashboard behind sign-in on https://demo.example.net/dashboard (CONSOLE_AUTH=token); pnpm console:link prints a sign-in link; /staff local only, 404 through the tunnel');
    const laptop = loadConfig({ ...base, PUBLIC_HOST: 'localhost', PORT: '3000', CONSOLE_AUTH: 'token' });
    expect(consoleExposure(laptop)).toBe('console: /dashboard behind sign-in on http://localhost:3000/dashboard (CONSOLE_AUTH=token); pnpm console:link prints a sign-in link');
    const open = loadConfig({ ...base, CONSOLE_AUTH: 'token', CONSOLE_LOCAL_ONLY: 'off' });
    expect(consoleExposure(open, ['/dashboard', '/staff'])).toMatch(/; \/staff PUBLIC \(CONSOLE_LOCAL_ONLY=off\)$/);
  });
});

describe('parseSessionKey', () => {
  it('reads hex before base64, so a hex key is never read as base64', () => {
    const bytes = randomBytes(48);
    expect(parseSessionKey(bytes.toString('hex'))?.equals(bytes)).toBe(true);
    expect(parseSessionKey(bytes.toString('base64'))?.equals(bytes)).toBe(true);
  });

  it('refuses what is not a key', () => {
    expect(parseSessionKey('')).toBeNull();
    expect(parseSessionKey('!!!!')).toBeNull();
    expect(parseSessionKey(Buffer.alloc(32, 0).toString('hex'))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { appEnvironment, describeHost, hostRouting, loadHost, ownSettingsLines, splitOwnSettings, type HostApp } from './host';
import { serverSettingNames } from './serverSettings';
import { sharedAudiences } from './index';
import { useTestkit } from '../testing/apps';
import { defaultAppId } from '../core/app/registry';

useTestkit();

const FIXTURE = fileURLToPath(new URL('../testing/host/host.yaml', import.meta.url));
/** The server's own settings for the fixture: the numbers callers dial, invented, 555 range. */
export const HOST_NUMBERS = { CALLBACK_LINE: '+15555550300', SERVICE_LINE: '+15555550311', SERVICE_LINE_ES: '+15555550312' };

const stubApp = (id: string): HostApp => ({ id, app: { id } as HostApp['app'], env: {}, own: [], ignored: [] });

describe('hostRouting', () => {
  const routing = () => hostRouting({
    apps: [stubApp('one'), stubApp('two')],
    numbers: [{ variable: 'ONE_LINE', app: 'one' }, { variable: 'TWO_LINE', app: 'two' }, { variable: 'TWO_LINE_B', app: 'two' }],
    defaultApp: 'two',
    env: { ONE_LINE: '+15555550100', TWO_LINE: '+15555550200', TWO_LINE_B: ' +15555550201 ' },
  });

  it('picks the app by the number called, as a called condition matches it, and the default for any other number or none', () => {
    const r = routing();
    expect(r.appFor('+15555550100')).toBe('one');
    // As the carrier delivers it: a ten-digit national number matches its E.164 form.
    expect(r.appFor('5555550100')).toBe('one');
    expect(r.appFor('+15555550201')).toBe('two');
    expect(r.appFor('+15555550999')).toBe('two');
    expect(r.appFor(undefined)).toBe('two');
    expect(r.appFor('')).toBe('two');
    expect(r.apps.map((a) => a.id)).toEqual(['two', 'one']);
  });

  it('refuses a number unset, one not E.164, and one number held by two variables, each with the fix', () => {
    const base = { apps: [stubApp('one'), stubApp('two')], defaultApp: 'one' };
    expect(() => hostRouting({ ...base, numbers: [{ variable: 'ONE_LINE', app: 'one' }], env: {} })).toThrow("host.yaml's numbers name ONE_LINE, which is not set: set ONE_LINE in the server's settings file");
    expect(() => hostRouting({ ...base, numbers: [{ variable: 'ONE_LINE', app: 'one' }], env: { ONE_LINE: '555-0100' } })).toThrow('ONE_LINE (a number in host.yaml) is not an E.164 number');
    expect(() => hostRouting({ ...base, numbers: [{ variable: 'ONE_LINE', app: 'one' }, { variable: 'TWO_LINE', app: 'two' }], env: { ONE_LINE: '+15555550100', TWO_LINE: '+15555550100' } }))
      .toThrow('TWO_LINE and ONE_LINE hold the same number, so a call to it could reach "one" or "two"');
    expect(() => hostRouting({ ...base, numbers: [{ variable: 'X', app: 'three' }], env: { X: '+15555550100' } })).toThrow('"three", which is not one of the apps');
  });
});

describe('the number called', () => {
  it('is read from a SIP address by its user part, and a ten-digit number matching two numbers is warned of and reaches the first', () => {
    const r = hostRouting({
      apps: [stubApp('one'), stubApp('two'), stubApp('three')],
      numbers: [{ variable: 'US_LINE', app: 'one' }, { variable: 'UK_LINE', app: 'two' }],
      defaultApp: 'three',
      env: { US_LINE: '+15555550100', UK_LINE: '+445555550100' },
    });
    expect(r.appFor('sip:+15555550100@10.0.0.5:5060')).toBe('one');
    expect(r.appFor('sips:+445555550100@pbx.example.com;transport=tls')).toBe('two');
    expect(r.appFor('+445555550100')).toBe('two');
    expect(r.appFor('5555550100')).toBe('one');
    expect(r.warnings).toEqual(['US_LINE and UK_LINE end in the same ten digits: a call whose number called comes as those ten digits alone reaches "one", the first listed']);
  });
});

describe('chat sign-in per app', () => {
  const jwt = { origins: { any: false, set: new Set(['https://www.example.com']) }, idleMs: 1, maxSessions: 1, signIn: { method: 'jwt' as const, jwksUrl: 'https://id.example.com/jwks', issuer: 'https://id.example.com', audience: 'portal' } };
  it('takes an app\'s own CHAT_AUDIENCE and CHAT_ISSUER, and warns of two apps sharing one', () => {
    expect(sharedAudiences(jwt, [{ id: 'one', env: {} }, { id: 'two', env: {} }])).toEqual(['one, two take tokens for one audience, so a token for one\'s portal signs in at the others\' chats: give each app its own CHAT_AUDIENCE in its own settings file']);
    expect(sharedAudiences(jwt, [{ id: 'one', env: { CHAT_AUDIENCE: 'one-portal' } }, { id: 'two', env: {} }])).toEqual([]);
    expect(sharedAudiences(jwt, [{ id: 'one', env: {} }])).toEqual([]);
  });
});

describe('appEnvironment', () => {
  it('reads an app\'s own file for the variables it names only, over the server\'s, and names the rest as not read', () => {
    const r = appEnvironment({ MAIN_LINE: '+15555550900', HANDOFF_NUMBER: '+15555550999' }, { MAIN_LINE: '+15555550101', TWILIO_AUTH_TOKEN: 'x' }, ['MAIN_LINE', 'VIP_DESK']);
    expect(r.env.MAIN_LINE).toBe('+15555550101');
    expect(r.env.HANDOFF_NUMBER).toBe('+15555550999');
    expect(r.env.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(r.own).toEqual(['MAIN_LINE']);
    expect(r.ignored).toEqual(['TWILIO_AUTH_TOKEN']);
    // What the app's code reads by name (ctx.env): the whole of its own file over the server's settings.
    expect(r.settings).toEqual({ MAIN_LINE: '+15555550101', HANDOFF_NUMBER: '+15555550999', TWILIO_AUTH_TOKEN: 'x' });
    expect(appEnvironment({ MAIN_LINE: '+15555550900' }, null, ['MAIN_LINE']).settings).toEqual({ MAIN_LINE: '+15555550900' });
  });
});

describe('the server\'s own settings, left in an app\'s own file', () => {
  it('are known from what the server\'s readers read: carriers, model keys, the host, the stores, the chat', () => {
    const names = serverSettingNames();
    for (const n of ['TWILIO_AUTH_TOKEN', 'TELNYX_PUBLIC_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'JEV_API_KEY', 'ANTHROPIC_API_KEY', 'PUBLIC_HOST', 'PORT', 'SESSION_STORE', 'AUDIT_STORE', 'TRACE_STORE', 'S3_SECRET_ACCESS_KEY', 'CHAT_ALLOWED_ORIGINS', 'CONSOLE_SESSION_KEY']) expect(names.has(n), n).toBe(true);
    for (const n of ['VIP_NUMBERS', 'MAIN_LINE', 'SPANISH_LINE']) expect(names.has(n), n).toBe(false);
  });

  it('are warned of by name; any other name is the app\'s code\'s, said as information', () => {
    expect(splitOwnSettings(['VIP_NUMBERS', 'TWILIO_AUTH_TOKEN', 'PUBLIC_HOST'])).toEqual({ server: ['TWILIO_AUTH_TOKEN', 'PUBLIC_HOST'], code: ['VIP_NUMBERS'] });
    expect(ownSettingsLines('apps/one/.env', ['VIP_NUMBERS'])).toEqual({ warn: null, info: 'apps/one/.env also sets VIP_NUMBERS, not named by its YAML: available to its code through ctx.env' });
    expect(ownSettingsLines('apps/one/.env', ['TWILIO_AUTH_TOKEN', 'PUBLIC_HOST']).warn).toBe("apps/one/.env sets TWILIO_AUTH_TOKEN, PUBLIC_HOST, the server's own settings: under a host the server reads them only from its own settings file, so here they do nothing");
  });
});

describe('loadHost', () => {
  it('imports and registers each app the fixture lists, each with its own MAIN_LINE, and routes its numbers', async () => {
    const host = await loadHost(FIXTURE, { ...HOST_NUMBERS });
    expect(host.apps.map((a) => a.id)).toEqual(['callback', 'routed']);
    expect(host.get('callback').app.brand?.name).toBe('Example Callbacks');
    expect(host.get('callback').env.MAIN_LINE).toBe('+15555550101');
    expect(host.get('routed').env.MAIN_LINE).toBe('+15555550201');
    // One app's own variable never reaches another.
    expect(host.get('callback').env.SPANISH_LINE).toBeUndefined();
    expect(host.get('routed').env.CALLBACK_DESK).toBeUndefined();
    expect(host.appFor(HOST_NUMBERS.SERVICE_LINE_ES)).toBe('routed');
    expect(host.appFor('+15555550777')).toBe('callback');
    // The test file's own default stays: the host's apps are registered beside it.
    expect(defaultAppId()).toBe('testkit');
    expect(describeHost(host)).toEqual([
      'app callback: numbers CALLBACK_LINE (the default: any other number, or none); its own CALLBACK_DESK, MAIN_LINE, PRIORITY_LINE, SECURITY_DESK',
      'app routed: numbers SERVICE_LINE, SERVICE_LINE_ES; its own AFTER_HOURS_DESK, MAIN_LINE, SPANISH_LINE, VIP_DESK',
    ]);
  });

  it('says every problem of a host file, and a number it names unset', async () => {
    await expect(loadHost(FIXTURE, {})).rejects.toThrow("host.yaml's numbers name CALLBACK_LINE, which is not set");
  });
});

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { appEnvironment, describeHost, hostRouting, loadHost, type HostApp } from './host';
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

describe('appEnvironment', () => {
  it('reads an app\'s own file for the variables it names only, over the server\'s, and names the rest as not read', () => {
    const r = appEnvironment({ MAIN_LINE: '+15555550900', HANDOFF_NUMBER: '+15555550999' }, { MAIN_LINE: '+15555550101', TWILIO_AUTH_TOKEN: 'x' }, ['MAIN_LINE', 'VIP_DESK']);
    expect(r.env.MAIN_LINE).toBe('+15555550101');
    expect(r.env.HANDOFF_NUMBER).toBe('+15555550999');
    expect(r.env.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(r.own).toEqual(['MAIN_LINE']);
    expect(r.ignored).toEqual(['TWILIO_AUTH_TOKEN']);
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

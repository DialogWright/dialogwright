import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceResultEvent } from '../channel/events';
import type { ServiceDef, App } from '../core/app/types';
import { testkitApp } from '../testing/testkit';
import { SERVICE_CEILING_MS, resolveService } from './services';

/** Small apps built on the testkit: one declares an agent of its own, the other none. */
const scout: ServiceDef = {
  resolve: async (params, { url }) => serviceResultEvent('scout', { url, seen: Object.keys(params) }),
  fromLog: (r) => r,
};
const hooked: App = { ...testkitApp, id: 'agents-hooked', services: { scout } };
const bare: App = { ...testkitApp, id: 'agents-bare', services: {} };

describe('downstream services from the app', () => {
  it('an effect is asked of the app\'s agent, at the url the launcher gave it', async () => {
    const answer = await resolveService(hooked, { kind: 'service', service: 'scout', params: { a: '1' } }, { scout: 'http://scout' });
    expect(answer).toEqual(serviceResultEvent('scout', { url: 'http://scout', seen: ['a'] }));
    expect((await resolveService(hooked, { kind: 'service', service: 'scout', params: {} }, undefined)).result).toEqual({ url: null, seen: [] });
  });

  it('an agent the app does not declare answers at once with no result', async () => {
    expect(await resolveService(bare, { kind: 'service', service: 'depot', params: { a: '1' } }, { depot: 'http://x' })).toEqual(serviceResultEvent('depot', null));
  });

  describe('an agent that breaks its contract fails closed', () => {
    afterEach(() => vi.useRealTimers());
    const effect = { kind: 'service', service: 'scout', params: {} } as const;
    const withAgent = (resolve: ServiceDef['resolve']): App => ({ ...testkitApp, id: 'agents-broken', services: { scout: { ...scout, resolve } } });

    it('a rejection is a no-answer with reason service-error', async () => {
      const app = withAgent(async () => { throw new Error('boom'); });
      expect(await resolveService(app, effect, undefined)).toEqual(serviceResultEvent('scout', null, { outcome: 'no-answer', reason: 'service-error' }));
    });

    it('a synchronous throw is the same', async () => {
      const app = withAgent(() => { throw new Error('boom'); });
      expect((await resolveService(app, effect, undefined)).note).toEqual({ outcome: 'no-answer', reason: 'service-error' });
    });

    it('an agent that never settles is a no-answer with reason timeout at the engine ceiling', async () => {
      vi.useFakeTimers();
      const app = withAgent(() => new Promise(() => undefined));
      const asked = resolveService(app, effect, undefined);
      await vi.advanceTimersByTimeAsync(SERVICE_CEILING_MS - 1);
      let settled = false;
      void asked.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await asked).toEqual(serviceResultEvent('scout', null, { outcome: 'no-answer', reason: 'timeout' }));
    });

    it('a shortened budget gets a short grace before the ceiling, so an agent that honors it is not cut off', async () => {
      vi.useFakeTimers();
      const app = withAgent(() => new Promise(() => undefined));
      const asked = resolveService(app, effect, undefined, 100);
      await vi.advanceTimersByTimeAsync(400);
      expect((await asked).note).toEqual({ outcome: 'no-answer', reason: 'timeout' });
    });

    it('an agent that answers within its budget is untouched, and leaves no timer behind', async () => {
      vi.useFakeTimers();
      const answer = await resolveService(hooked, { kind: 'service', service: 'scout', params: {} }, undefined);
      expect(answer.result).toEqual({ url: null, seen: [] });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('an answer for another agent is not this one\'s: a no-answer', async () => {
      const app = withAgent(async () => serviceResultEvent('other', { x: 1 }));
      expect(await resolveService(app, effect, undefined)).toEqual(serviceResultEvent('scout', null, { outcome: 'no-answer', reason: 'service-error' }));
    });
  });
});

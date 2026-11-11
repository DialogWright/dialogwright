import type { ConverseApp, Texts } from 'dialogwright';
import { shopTools, wheelshop } from './app';
import { shopConfigOf, Systems } from './shop';

/**
 * What the tests of the shop's systems share: systems configured from the app's agent.yaml with a clock a
 * test sets, and an action run as the runtime runs it once the gate has allowed it (its key, a sender, the
 * caller, the app's settings). Test support only.
 */

let business: ConverseApp['business'] | null = null;
const clocks = new WeakMap<Systems, { ms: number }>();

/** New systems, as a server starts with: agent.yaml's calendar, time zone and accounts, and a clock set by `run`. */
export function newSystems(ms = 0): Systems {
  business ??= wheelshop({ env: () => undefined }).app.business;
  const clock = { ms };
  const sys = new Systems(() => clock.ms);
  sys.configure(shopConfigOf(business));
  clocks.set(sys, clock);
  return sys;
}

/** Sets the systems' clock. */
export function setClock(sys: Systems, ms: number): void {
  clocks.get(sys)!.ms = ms;
}

/** An action run with a write key at `nowMs`, as the runtime runs it after the gate: its result (the model is shown it) as `summary`. */
export async function run(sys: Systems, tool: string, params: Record<string, string>, key: string, nowMs: number, o: { texts?: Texts; env?: (name: string) => string | undefined; account?: string | null } = {}): Promise<{ summary: string }> {
  setClock(sys, nowMs);
  const impl = shopTools(sys)[tool];
  if (impl === undefined) throw new Error(`no action ${tool}`);
  const result = await impl(params, { key, texts: o.texts ?? null, caller: { account: o.account === undefined ? params.account ?? null : o.account }, env: o.env ?? (() => undefined) });
  return { summary: String(result) };
}

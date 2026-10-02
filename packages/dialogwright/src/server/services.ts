import { serviceResultEvent, type ServiceResult } from '../channel/events';
import type { Effect } from '../core/lifecycle';
import type { App } from '../core/app/types';

/**
 * Where each of the app's downstream services (App.services) is reached, by name, as the launcher that
 * started them passes it; a service with no entry, or a null one, is not running.
 */
export type ServiceUrls = Readonly<Record<string, string | null>>;

/** How long the engine waits for a service that gives no budget of its own (an app's service keeps its own, shorter one). */
export const SERVICE_CEILING_MS = 15_000;
/** Added to a shortened `timeoutMs`, so a service that honors its own budget answers before the engine's ceiling does. */
const CEILING_GRACE_MS = 250;

/**
 * A turn's service effect, asked of the app's service: its answer, as the event the core runs as the
 * call's next turn. The one place both channels ask: the voice adapter queues it as the turn after
 * the one that left the effect (adapter.ts queueService), and a chat turn awaits it inline. A service
 * the app does not declare answers at once with no result.
 *
 * The service is app code, and the engine does not trust it to keep its contract: its promise is raced
 * against a ceiling (`timeoutMs` plus a grace when given, else SERVICE_CEILING_MS), and a rejection, a
 * timeout, or an answer for some other service all become a no-answer for this one (reason
 * 'service-error' or 'timeout'), so the turn that follows clears the call's wait and its queue never
 * blocks. `timeoutMs` shortens the service's own budget (tests).
 */
export async function resolveService(app: App, effect: Effect, urls: ServiceUrls | undefined, timeoutMs?: number): Promise<ServiceResult> {
  const service = app.services?.[effect.service];
  if (!service) return serviceResultEvent(effect.service, null);
  const noAnswer = (reason: 'service-error' | 'timeout'): ServiceResult => serviceResultEvent(effect.service, null, { outcome: 'no-answer', reason });
  const ceilingMs = timeoutMs !== undefined ? timeoutMs + CEILING_GRACE_MS : SERVICE_CEILING_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<ServiceResult>((resolve) => { timer = setTimeout(() => resolve(noAnswer('timeout')), ceilingMs); });
  try {
    const asked = Promise.resolve().then(() => service.resolve(effect.params, { url: urls?.[effect.service] ?? null, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }));
    // A rejection that comes after the ceiling has won is handled here, not left unhandled.
    asked.catch(() => undefined);
    const answer = await Promise.race([asked, ceiling]);
    return answer.type === 'service.result' && answer.service === effect.service ? answer : noAnswer('service-error');
  } catch {
    return noAnswer('service-error');
  } finally {
    clearTimeout(timer);
  }
}

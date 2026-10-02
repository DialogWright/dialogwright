import { resetAppsForTest } from '../core/app/registry';
import { registerTestkit } from './testkit';

/**
 * Engine tests run on the testkit: call this once at the top of a test file, before anything that
 * reads the default app (a fixture loaded at module level, a loop that builds tests). The registry
 * is cleared first, so the file sees exactly the testkit, plus whatever apps it registers itself
 * after this call. It acts at once rather than in a beforeAll, because a test file's own
 * module-level code runs before any hook.
 */
export function useTestkit(): void {
  resetAppsForTest();
  registerTestkit();
}

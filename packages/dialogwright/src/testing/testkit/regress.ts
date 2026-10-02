// Launcher for `pnpm regress:testkit`: registers the testkit app, then runs the engine's regression run.
// With DIALOGWRIGHT_SHADOW set, each slot in TESTKIT_SHADOW_PAIRS runs beside the slot it replaces
// (testing/shadowSlot.ts); unset, the app is registered as it is.
import { registerApp } from '../../core/app/registry';
import { testkitApp } from './index';
import { TESTKIT_SHADOW_PAIRS } from './shadowPairs';
import { shadowFromEnv } from '../shadowSlot';
import { main } from '../../harness-text/regress';

registerApp(shadowFromEnv(testkitApp, TESTKIT_SHADOW_PAIRS));
await main();

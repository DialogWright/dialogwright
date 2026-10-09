// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/routed/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { routedApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(routedApp);
await main();

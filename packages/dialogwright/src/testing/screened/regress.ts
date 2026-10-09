// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/screened/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { screenedApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(screenedApp);
await main();

// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/recognized/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { recognizedApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(recognizedApp);
await main();

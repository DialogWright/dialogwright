// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/texting/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { textingApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(textingApp);
await main();

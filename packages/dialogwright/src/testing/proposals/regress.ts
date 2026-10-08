// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/proposals/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { proposalsApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(proposalsApp);
await main();

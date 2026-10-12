// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/message/regress.ts --scenario <id>`.
// On the stub, generated lines are worded by the fake renderer (no model is asked).
import { registerApp } from '../../core/app/registry';
import { messageApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(messageApp);
await main();

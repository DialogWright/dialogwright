// Launcher for the fixture's scripted calls, turn by turn: `tsx src/testing/callback/regress.ts --scenario <id>`.
import { registerApp } from '../../core/app/registry';
import { callbackApp } from './app';
import { main } from '../../harness-text/regress';

registerApp(callbackApp);
await main();

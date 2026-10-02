// Launcher for `pnpm regress:testkit`: registers the testkit app, then runs the engine's regression run.
import { registerApp } from '../../core/app/registry';
import { testkitApp } from './index';
import { main } from '../../harness-text/regress';

registerApp(testkitApp);
await main();

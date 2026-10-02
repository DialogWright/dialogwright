// Launcher for `pnpm regress:testkit`: registers the testkit app, then runs the engine's regression run.
import { registerTestkit } from './index';
import { main } from '../../harness-text/regress';

registerTestkit();
await main();

// Launcher for the regression with the adversarial suite on, on the testkit (harness-text/regress.test.ts):
// the testkit as an app whose app.yaml says `testing: { adversarial: on }`.
import { registerApp } from '../../core/app/registry';
import { testkitApp } from './index';
import { main } from '../../harness-text/regress';

registerApp({ ...testkitApp, adversarial: true });
await main();

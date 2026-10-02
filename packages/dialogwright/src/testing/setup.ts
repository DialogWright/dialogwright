import { registerTestkit } from './testkit';

// Every test file starts with the testkit registered: it is the default app, so engine tests
// run on a neutral app. A test that needs another app registers it itself.
registerTestkit();

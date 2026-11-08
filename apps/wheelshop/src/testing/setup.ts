import { resetAppsForTest } from 'dialogwright';
import { registerThisApp } from '../index';

// The app is the default app in every test file, as the engine's own tests have the testkit.
resetAppsForTest();
registerThisApp();

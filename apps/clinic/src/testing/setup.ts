import { resetAppsForTest } from 'dialogwright';
import { registerClinic } from '../index';

// The clinic is the default app in every test file, as the engine's own tests have the testkit.
resetAppsForTest();
registerClinic();

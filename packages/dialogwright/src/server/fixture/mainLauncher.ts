// A tiny launcher for main.test.ts, run in a child process: it registers the testkit and runs the
// server's process entry point, as an app's serve.ts does. LAUNCHER_MODE picks what it does besides:
//   hold     its sidecar takes a minute to close, so a stop is still under way when a second signal comes;
//   throw    it throws inside a timer once the server is up (an uncaught exception);
//   reject   it leaves a rejected promise unhandled once the server is up.
import { registerTestkit } from '../../testing/testkit';
import { main } from '../index';

registerTestkit();
const mode = process.env.LAUNCHER_MODE ?? '';
await main(async () => (mode === 'hold' ? { close: () => new Promise<void>((resolve) => setTimeout(resolve, 60_000)) } : {}));
if (mode === 'throw') {
  setTimeout(() => {
    throw new Error('launcher boom');
  }, 20);
}
if (mode === 'reject') setTimeout(() => void Promise.reject(new Error('launcher rejection')), 20);

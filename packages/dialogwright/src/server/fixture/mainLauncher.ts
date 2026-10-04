// A tiny launcher for main.test.ts, run in a child process: it registers the testkit and runs the
// server's process entry point, as an app's serve.ts does. LAUNCHER_MODE picks what it does besides:
//   hold        its sidecar takes a minute to close, so a stop is still under way when a second signal comes;
//   throw       it throws inside a timer once the server is up (an uncaught exception, with a cause);
//   throw-hold  the same, with the sidecar that takes a minute to close;
//   reject      it leaves a rejected promise unhandled once the server is up.
// Its sidecar says when it has closed, so a test can see the close a crash makes.
import { registerTestkit } from '../../testing/testkit';
import { main } from '../index';

registerTestkit();
const mode = process.env.LAUNCHER_MODE ?? '';
const slow = mode === 'hold' || mode === 'throw-hold';
await main(async () => ({
  close: () =>
    new Promise<void>((resolve) =>
      setTimeout(() => {
        console.log('[launcher] sidecars closed');
        resolve();
      }, slow ? 60_000 : 10),
    ),
}));
if (mode === 'throw' || mode === 'throw-hold') {
  setTimeout(() => {
    throw new Error('launcher boom', { cause: new Error('the cause of it') });
  }, 20);
}
if (mode === 'reject') setTimeout(() => void Promise.reject(new Error('launcher rejection')), 20);

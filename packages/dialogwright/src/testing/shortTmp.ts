import { tmpdir } from 'node:os';

/**
 * For the engine's own tests that start a process through tsx; not part of the testing API.
 *
 * tsx opens an IPC pipe under the temporary folder (`<tmpdir>/tsx-<uid>/<pid>.pipe`), and a Unix
 * socket's path is at most 104 bytes on macOS (108 on Linux): with a long TMPDIR, such as a
 * sandbox's, the child fails with EINVAL before it runs a line. These tests use a short root
 * instead: the system's temporary folder when its path is short, otherwise /tmp.
 */
const LONGEST = 60;

/** A temporary folder root short enough for a socket path under it. */
export const SHORT_TMP: string = tmpdir().length <= LONGEST || process.platform === 'win32' ? tmpdir() : '/tmp';

/** `env` with TMPDIR set to SHORT_TMP, for a child process that runs tsx. */
export function withShortTmp(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, TMPDIR: SHORT_TMP };
}

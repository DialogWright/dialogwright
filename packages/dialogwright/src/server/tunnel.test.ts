import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { findOnPath, quickTunnelHost, waitForQuickTunnel, type TunnelProcess } from './tunnel';

/** The quick tunnel's hostname, read from cloudflared's output (fixture/cloudflared-quick.README.md says where the samples come from). No test runs cloudflared. */

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixture/${name}`, import.meta.url)), 'utf8');

/** A cloudflared that prints what it is given, when it is told to. */
function fakeCloudflared(): TunnelProcess & { say(text: string, stream?: 'stdout' | 'stderr'): void; exit(code: number): void } {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(emitter, {
    stdout,
    stderr,
    say: (text: string, stream: 'stdout' | 'stderr' = 'stderr') => (stream === 'stdout' ? stdout : stderr).write(text),
    exit: (code: number) => emitter.emit('exit', code, null),
  });
}

describe('quickTunnelHost', () => {
  for (const [name, host] of [['cloudflared-quick-2024.txt', 'example-quiet-harbor-words.trycloudflare.com'], ['cloudflared-quick-2022.txt', 'sample-river-lantern-test.trycloudflare.com']] as const) {
    it(`finds the hostname in ${name}, and not the other https addresses`, () => {
      expect(quickTunnelHost(fixture(name))).toBe(host);
    });
  }

  it('finds nothing before the box is printed', () => {
    const lines = fixture('cloudflared-quick-2024.txt').split('\n');
    expect(quickTunnelHost(lines.slice(0, 3).join('\n'))).toBeNull();
    expect(quickTunnelHost('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });
});

describe('waitForQuickTunnel', () => {
  it('resolves with the hostname once cloudflared prints it, in pieces, on either stream', async () => {
    const c = fakeCloudflared();
    const waiting = waitForQuickTunnel(c, 5_000);
    const text = fixture('cloudflared-quick-2024.txt');
    c.say(text.slice(0, 400));
    c.say(text.slice(400, 520), 'stdout');
    c.say(text.slice(520));
    await expect(waiting).resolves.toBe('example-quiet-harbor-words.trycloudflare.com');
  });

  it('gives up with a clear error when no hostname comes in time', async () => {
    const c = fakeCloudflared();
    c.say('2026-10-04T17:02:11Z INF Requesting new quick Tunnel on trycloudflare.com...\n');
    await expect(waitForQuickTunnel(c, 50)).rejects.toThrow(
      'cloudflared gave no quick tunnel hostname within 0.05 seconds (its last line: "2026-10-04T17:02:11Z INF Requesting new quick Tunnel on trycloudflare.com...")',
    );
  });

  it('says so when cloudflared exits first', async () => {
    const c = fakeCloudflared();
    const waiting = waitForQuickTunnel(c, 5_000);
    c.say('2026-10-04T17:02:11Z ERR failed to request quick Tunnel: example failure\n');
    c.exit(1);
    await expect(waiting).rejects.toThrow('cloudflared exited (code 1) before it gave a hostname (its last line: "2026-10-04T17:02:11Z ERR failed to request quick Tunnel: example failure")');
  });
});

describe('findOnPath', () => {
  it('finds an executable on PATH, and not a file that cannot run or a folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'path-'));
    try {
      const a = join(root, 'a');
      const b = join(root, 'b');
      mkdirSync(a);
      mkdirSync(b);
      writeFileSync(join(a, 'cloudflared'), 'not executable');
      mkdirSync(join(a, 'tool'));
      writeFileSync(join(b, 'cloudflared'), '#!/bin/sh\n');
      chmodSync(join(b, 'cloudflared'), 0o755);
      const env = { PATH: [a, b].join(process.platform === 'win32' ? ';' : ':') };
      expect(findOnPath('cloudflared', env)).toBe(join(b, 'cloudflared'));
      expect(findOnPath('tool', env)).toBeNull();
      expect(findOnPath('cloudflared', { PATH: a })).toBeNull();
      expect(findOnPath('cloudflared', {})).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

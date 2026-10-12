import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FrameDir = 'in' | 'out' | 'http' | 'log';

export interface FrameLogLine {
  ts: string;
  dir: FrameDir;
  msg: unknown;
  /** 1-based line number in the log file, so a skip report can point back at the source line. Not written by FrameLog.write; only readFrameLog populates it. */
  line?: number;
}

/** What readFrameLog actually returns: `line` is always populated. */
export type ReadFrameLogLine = FrameLogLine & { line: number };

/** Where a call's frame-log lines go: the file (FrameLog), or a trace store's segments (trace/store.ts). */
export interface FrameSink {
  write(dir: FrameDir, msg: unknown): void;
}

/** One frame-log line as it is written, without its newline: the same wherever it is kept. */
export function frameLine(atMs: number, dir: FrameDir, msg: unknown): string {
  const line: FrameLogLine = { ts: new Date(atMs).toISOString(), dir, msg };
  return JSON.stringify(line);
}

/** Every socket message and webhook for one call, in arrival order. This is what replay consumes. */
export class FrameLog implements FrameSink {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(dir: FrameDir, msg: unknown): void {
    appendFileSync(this.path, frameLine(this.now(), dir, msg) + '\n');
  }
}

export function readFrameLog(path: string, onSkip?: (lineNumber: number) => void): ReadFrameLogLine[] {
  return parseFrameLog(readFileSync(path, 'utf8'), onSkip);
}

/** A frame log's text read back, each line with its 1-based number; one that does not parse is passed to `onSkip`. */
export function parseFrameLog(text: string, onSkip?: (lineNumber: number) => void): ReadFrameLogLine[] {
  const lines: ReadFrameLogLine[] = [];
  const raw = text.split('\n');
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    const lineNumber = i + 1;
    try {
      const parsed = JSON.parse(l) as FrameLogLine;
      lines.push({ ...parsed, line: lineNumber });
    } catch {
      onSkip?.(lineNumber);
    }
  });
  return lines;
}

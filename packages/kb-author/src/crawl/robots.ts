/**
 * robots.txt, read minimally after RFC 9309:
 *
 * - Groups start with one or more `User-agent` lines; `Allow`, `Disallow` and `Crawl-delay` lines
 *   belong to the group above them. Comments (`#`) and other lines (`Sitemap`) are ignored.
 * - The crawler's own groups (`dialogwright-kb`, or the full `dialogwright-kb-ingest`, any case)
 *   apply when there are any, all of them together; otherwise the `*` groups do; otherwise nothing is
 *   disallowed.
 * - A path is matched against each rule's pattern from its start (`*` matches any characters, a final
 *   `$` anchors the end); the longest matching pattern wins, and `Allow` wins a tie. An empty
 *   `Disallow` allows everything. `/robots.txt` itself is always allowed.
 */

/** The product tokens a robots.txt group may name the crawler by. */
export const ROBOTS_AGENTS = ['dialogwright-kb', 'dialogwright-kb-ingest'] as const;

interface Rule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

/** The rules that apply to the crawler on one host. */
export interface Robots {
  /** Whether the crawler may fetch a URL's path (with its query). */
  allows(pathAndQuery: string): boolean;
  /** The Crawl-delay the applicable groups ask for, in seconds, if any. */
  readonly crawlDelay?: number;
}

/** A pattern as a regular expression matched at a path's start. */
function patternRegExp(pattern: string): RegExp {
  const end = pattern.endsWith('$');
  const body = (end ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
}

/** A path as a pattern compares it: percent-encodings in one case, so `%7e` and `%7E` are alike. */
function normalizePath(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/** Nothing disallowed (no robots.txt, or one the server says is not there). */
export const ALLOW_ALL: Robots = { allows: () => true };

/** Everything disallowed (a robots.txt the server could not give: a server error or no answer). */
export const DISALLOW_ALL: Robots = { allows: (path) => path === '/robots.txt' };

/** Parses a robots.txt for the crawler. */
export function parseRobots(text: string, agents: readonly string[] = ROBOTS_AGENTS): Robots {
  interface Group {
    agents: string[];
    rules: Rule[];
    delay?: number;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (value === '') continue;
      const pattern = normalizePath(value.startsWith('/') || value.startsWith('*') ? value : `/${value}`);
      current.rules.push({ allow: key === 'allow', pattern, regex: patternRegExp(pattern) });
    } else if (key === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.delay = delay;
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => agents.includes(a)));
  const chosen = ours.length > 0 ? ours : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen.map((g) => g.delay).filter((d): d is number => d !== undefined);
  return {
    allows(pathAndQuery: string): boolean {
      const path = normalizePath(pathAndQuery || '/');
      if (path === '/robots.txt') return true;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)) best = rule;
      }
      return best === null || best.allow;
    },
    ...(delays.length > 0 ? { crawlDelay: Math.max(...delays) } : {}),
  };
}

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The console on a phone (CONSOLE_AUTH=token opens it from one): a viewport that is the device's
 * width, and a narrow-screen block that stacks the panels, wraps the header (Sign out included) and
 * the replay bar, scrolls the audit and perception lists inside their own boxes, and gives buttons a
 * finger's height. Structure only: how it looks is checked in a browser.
 */
const page = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'page.html'), 'utf8');
const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));

function narrowBlock(): string {
  const at = style.search(/@media \(max-width: ?\d+px\)/);
  expect(at, 'a narrow-screen @media block').toBeGreaterThan(-1);
  // The block runs to the brace that closes it.
  let depth = 0;
  for (let i = style.indexOf('{', at); i < style.length; i++) {
    if (style[i] === '{') depth++;
    else if (style[i] === '}' && --depth === 0) return style.slice(at, i + 1);
  }
  throw new Error('the @media block does not close');
}

describe('the console page on a narrow screen', () => {
  it('has a viewport of the device\'s width', () => {
    expect(page).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
    expect(page).not.toContain('content="width=1920"');
  });

  it('keeps one style and one inline script, for the policy\'s nonce', () => {
    expect(page.match(/<style[ >]/g)).toHaveLength(1);
    expect(page.match(/<script[ >]/g)).toHaveLength(1);
    expect(page).toContain('<script type="module">');
  });

  it('stacks the panels, wraps the header and the replay bar, and scrolls lists in their own boxes', () => {
    const block = narrowBlock();
    const rule = (selector: string): string => {
      const m = new RegExp(`(?:^|[\\s,}])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm').exec(block);
      expect(m, `a rule for ${selector}`).not.toBeNull();
      return m![1]!.replace(/\s+/g, '');
    };
    expect(rule('header')).toContain('flex-wrap:wrap');
    expect(rule('header')).toContain('height:auto');
    expect(rule('.actions')).toContain('flex-wrap:wrap');
    expect(rule('.replaybar')).toContain('flex-wrap:wrap');
    expect(rule('main')).toContain('grid-template-columns:minmax(0,1fr)');
    expect(rule('main')).toContain('height:auto');
    expect(rule('.right')).toContain('overflow:visible');
    expect(rule('.alist')).toContain('overflow-x:auto');
    expect(rule('.perception')).toContain('overflow-x:auto');
    expect(rule('button')).toMatch(/min-height:(4[0-9]|[5-9][0-9])px/);
  });
});

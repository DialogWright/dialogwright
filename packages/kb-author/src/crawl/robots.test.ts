import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots';
import { canonicalUrl, globToRegExp, included, neverFetched } from './url';

describe('robots.txt', () => {
  const text = [
    '# a comment',
    'User-agent: *',
    'Disallow: /private/',
    'Allow: /private/open.html',
    'Disallow: /*.cgi$',
    'Disallow: /search?',
    '',
    'User-agent: archive-bot',
    'Disallow: /',
  ].join('\n');

  it('applies the * group when none names the crawler: the longest match wins, Allow wins a tie', () => {
    const robots = parseRobots(text);
    expect(robots.allows('/')).toBe(true);
    expect(robots.allows('/private/staff.html')).toBe(false);
    expect(robots.allows('/private/open.html')).toBe(true);
    expect(robots.allows('/run.cgi')).toBe(false);
    expect(robots.allows('/run.cgi.html')).toBe(true);
    expect(robots.allows('/search?q=hours')).toBe(false);
    expect(robots.allows('/search')).toBe(true);
    expect(robots.allows('/robots.txt')).toBe(true);
    const tie = parseRobots('User-agent: *\nDisallow: /page\nAllow: /page\n');
    expect(tie.allows('/page')).toBe(true);
  });

  it("applies only the crawler's own groups when there are any, merged, by either token in any case", () => {
    const robots = parseRobots(['User-agent: *', 'Disallow: /', '', 'User-agent: DialogWright-KB', 'Disallow: /drafts/', '', 'User-agent: other', 'User-agent: dialogwright-kb-ingest', 'Disallow: /old/', 'Crawl-delay: 3'].join('\n'));
    expect(robots.allows('/')).toBe(true);
    expect(robots.allows('/drafts/a.html')).toBe(false);
    expect(robots.allows('/old/a.html')).toBe(false);
    expect(robots.crawlDelay).toBe(3);
  });

  it('reads an empty Disallow as allowing everything, and lines out of a group as nothing', () => {
    const robots = parseRobots('Disallow: /\nUser-agent: *\nDisallow:\n');
    expect(robots.allows('/anything')).toBe(true);
    expect(parseRobots('').allows('/x')).toBe(true);
  });

  it('compares percent-encodings in one case', () => {
    expect(parseRobots('User-agent: *\nDisallow: /caf%c3%a9/\n').allows('/caf%C3%A9/menu')).toBe(false);
  });

  it('has the two outcomes for a robots.txt not read: all allowed, all disallowed', () => {
    expect(ALLOW_ALL.allows('/x')).toBe(true);
    expect(DISALLOW_ALL.allows('/x')).toBe(false);
    expect(DISALLOW_ALL.allows('/robots.txt')).toBe(true);
  });
});

describe('URLs and globs', () => {
  it('keeps one canonical form: http(s) only, no fragment, no user name, lowercase host, no default port', () => {
    expect(canonicalUrl('HTTP://Example.TEST:80/a/../b.html?x=1#top')).toBe('http://example.test/b.html?x=1');
    expect(canonicalUrl('page.html#s', 'https://example.test/dir/')).toBe('https://example.test/dir/page.html');
    expect(canonicalUrl('mailto:desk@library.example')).toBeUndefined();
    expect(canonicalUrl('javascript:void(0)')).toBeUndefined();
    expect(canonicalUrl('http://user:pw@example.test/')).toBeUndefined();
    expect(canonicalUrl('http://[bad')).toBeUndefined();
  });

  it('matches globs over the path: a slash anchors the whole path, none matches the last segment', () => {
    expect(globToRegExp('/help/**').test('/help/a/b.html')).toBe(true);
    expect(globToRegExp('/help/*').test('/help/a/b.html')).toBe(false);
    expect(globToRegExp('help/*.html').test('/help/a.html')).toBe(true);
    expect(globToRegExp('*.pdf').test('/files/guide.pdf')).toBe(true);
    expect(globToRegExp('*.pdf').test('/files/guide.pdf.html')).toBe(false);
    expect(globToRegExp('guide-?.pdf').test('/x/guide-2.pdf')).toBe(true);
    expect(included('http://h.test/a.pdf', [])).toBe(true);
    expect(included('http://h.test/a.pdf', [globToRegExp('/docs/**')])).toBe(false);
  });

  it('never fetches images, styles, archives and the like', () => {
    expect(['/logo.png', '/site.css', '/a.zip', '/data.csv'].map((p) => neverFetched(`http://h.test${p}`))).toEqual([true, true, true, true]);
    expect(['/', '/a.html', '/guide.pdf', '/h.docx', '/page.php', '/dir/'].map((p) => neverFetched(`http://h.test${p}`))).toEqual([false, false, false, false, false, false]);
  });
});

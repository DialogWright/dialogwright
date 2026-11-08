import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { formFromOwnPage } from './localOnly';

/** formFromOwnPage: a form post from this server's own page, by Sec-Fetch-Site and Origin (the console's sign-in's check, for an app page's form too). */

const req = (headers: Record<string, string>, remoteAddress = '203.0.113.9'): IncomingMessage => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('formFromOwnPage', () => {
  it('takes a post from the page itself: same-origin, or no Origin, or null, or the public origin', () => {
    expect(formFromOwnPage(req({ 'sec-fetch-site': 'same-origin', origin: 'https://shop.example.com' }), 'shop.example.com')).toBe(true);
    expect(formFromOwnPage(req({}), 'shop.example.com')).toBe(true);
    expect(formFromOwnPage(req({ origin: 'null' }), 'shop.example.com')).toBe(true);
  });

  it('refuses a post from another site, by either header', () => {
    expect(formFromOwnPage(req({ 'sec-fetch-site': 'cross-site' }), 'shop.example.com')).toBe(false);
    expect(formFromOwnPage(req({ 'sec-fetch-site': 'same-site' }), 'shop.example.com')).toBe(false);
    expect(formFromOwnPage(req({ origin: 'https://evil.example' }), 'shop.example.com')).toBe(false);
    expect(formFromOwnPage(req({ origin: 'http://shop.example.com' }), 'shop.example.com')).toBe(false);
  });

  it('takes the plain http origin of a request made directly on this machine, and only then', () => {
    expect(formFromOwnPage(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }, '127.0.0.1'), 'shop.example.com')).toBe(true);
    expect(formFromOwnPage(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }), 'shop.example.com')).toBe(false);
    expect(formFromOwnPage(req({ host: 'attacker.example:3000', origin: 'http://attacker.example:3000' }, '127.0.0.1'), 'shop.example.com')).toBe(false);
  });
});

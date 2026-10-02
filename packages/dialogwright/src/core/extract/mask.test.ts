import { describe, expect, it } from 'vitest';
import { matchesMask } from './mask';
import { ACCOUNT_ID_MASK } from '../../testing/testkit/domain/slots/accountId';

describe('matchesMask', () => {
  it('accepts eight digits as an account ID', () => {
    expect(matchesMask('55501234', ACCOUNT_ID_MASK)).toBe(true);
  });
  it('rejects seven digits', () => {
    expect(matchesMask('5550123', ACCOUNT_ID_MASK)).toBe(false);
  });
  it('rejects letters', () => {
    expect(matchesMask('5550123A', ACCOUNT_ID_MASK)).toBe(false);
  });
});

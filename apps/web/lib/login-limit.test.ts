import { expect, test } from 'vitest';
import { deskClientKey } from './login-limit';

test('a desk client is the forwarded hop only when the proxy is trusted', () => {
  expect(
    deskClientKey({
      forwardedFor: '203.0.113.10, 198.51.100.1',
      trustProxy: false,
    }),
  ).toBeUndefined();
  expect(
    deskClientKey({
      forwardedFor: '203.0.113.10, 198.51.100.1',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.10');
  expect(
    deskClientKey({
      forwardedFor: ' ',
      trustProxy: true,
    }),
  ).toBeUndefined();
  expect(
    deskClientKey({ forwardedFor: null, trustProxy: true }),
  ).toBeUndefined();
});

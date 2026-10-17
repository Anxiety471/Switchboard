import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { generateToken, hashToken, secretsEqual } from './token.js';

test('tokens are random and stored as sha256 hashes', () => {
  const first = generateToken();
  const second = generateToken();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first).not.toBe(second);

  const hash = hashToken(first);
  expect(hash).toHaveLength(32);
  expect(hash.equals(createHash('sha256').update(first).digest())).toBe(true);
  expect(hash.equals(hashToken(second))).toBe(false);
});

test('secretsEqual compares registration secrets of any length', () => {
  expect(secretsEqual('same', 'same')).toBe(true);
  expect(secretsEqual('same', 'other')).toBe(false);
  expect(secretsEqual('short', 'a-much-longer-secret')).toBe(false);
  expect(secretsEqual('', '')).toBe(true);
  expect(secretsEqual('set', '')).toBe(false);
});

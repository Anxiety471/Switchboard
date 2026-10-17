import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { generateToken, hashesEqual, hashToken } from './token.js';

test('tokens are random and only their sha256 hash compares', () => {
  const first = generateToken();
  const second = generateToken();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first).not.toBe(second);

  const hash = hashToken(first);
  expect(hash).toHaveLength(32);
  expect(hash.equals(createHash('sha256').update(first).digest())).toBe(true);
  expect(hashesEqual(hash, hashToken(first))).toBe(true);
  expect(hashesEqual(hash, hashToken(second))).toBe(false);
  expect(hashesEqual(undefined, hashToken(second))).toBe(false);
  expect(hashesEqual(Buffer.alloc(16), hashToken(second))).toBe(false);
  expect(hashesEqual(hash, Buffer.alloc(16))).toBe(false);
});

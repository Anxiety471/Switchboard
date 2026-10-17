import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH_BYTES = 32;

export function generateToken(): string {
  return randomBytes(HASH_BYTES).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function secretsEqual(expected: string, provided: string): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(provided).digest();
  return timingSafeEqual(left, right);
}

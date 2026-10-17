import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH_BYTES = 32;
const dummyHash = createHash('sha256')
  .update('switchboard-dummy-token')
  .digest();

export function generateToken(): string {
  return randomBytes(HASH_BYTES).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export function hashesEqual(
  stored: Buffer | undefined,
  presented: Buffer,
): boolean {
  const right = presented.length === dummyHash.length ? presented : dummyHash;
  const left =
    stored !== undefined && stored.length === right.length ? stored : dummyHash;
  const equal = timingSafeEqual(left, right);
  return (
    stored !== undefined &&
    presented.length === dummyHash.length &&
    stored.length === presented.length &&
    equal
  );
}

export function asHashBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  return undefined;
}

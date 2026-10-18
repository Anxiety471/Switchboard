import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { DeskFailure } from './ledger';

export const DESK_COOKIE = 'switchboard_desk';
export const FLASH_COOKIE = 'switchboard_flash';
export const THEME_COOKIE = 'switchboard_theme';
export const TOKEN_COOKIE = 'switchboard_token';

const TOKEN_TTL_MS = 120_000;

const FORM_CSRF_TTL_MS = 2 * 60 * 60 * 1000;

export type CookieOptions = {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict';
  path: '/';
  secure: boolean;
  maxAge: number;
};

export type Flash =
  | {
      type: 'issued';
      id: string;
      name: string;
      token: string;
      handover: boolean;
    }
  | { type: 'revoked'; name: string }
  | { type: 'failure'; failure: DeskFailure };

export type IssuedSlip = {
  id: string;
  name: string;
  token: string;
  handover: boolean;
  exp: number;
};

export class ReturnPathError extends Error {
  readonly status = 400 as const;

  constructor() {
    super('invalid return path');
    this.name = 'ReturnPathError';
  }
}

export function secretsEqual(expected: string, provided: string): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(provided).digest();
  return timingSafeEqual(left, right);
}

export function issueFormCsrf(secret: string, now = Date.now()): string {
  const expires = now + FORM_CSRF_TTL_MS;
  const mac = createHmac('sha256', secret)
    .update(`form.${expires}`)
    .digest('base64url');
  return `${expires}.${mac}`;
}

export function formCsrfValid(
  secret: string,
  token: string,
  now = Date.now(),
): boolean {
  if (secret === '') {
    return false;
  }
  const dot = token.indexOf('.');
  if (dot <= 0) {
    return false;
  }
  const expiresText = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^[0-9]+$/.test(expiresText) || !/^[A-Za-z0-9_-]+$/.test(mac)) {
    return false;
  }
  const expires = Number(expiresText);
  if (
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + FORM_CSRF_TTL_MS + 60_000
  ) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`form.${expires}`)
    .digest('base64url');
  return secretsEqual(expected, mac);
}

export function themeFromCookie(
  value: string | undefined,
): 'light' | 'dark' | 'system' {
  if (value === 'light' || value === 'dark') {
    return value;
  }
  return 'system';
}

export function sessionCookie(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: 60 * 60 * 12,
  };
}

export function flashCookie(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: 120,
  };
}

export function tokenCookie(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    maxAge: 120,
  };
}

export function themeCookie(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: 60 * 60 * 24 * 365,
  };
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite === 'strict' ? 'Strict' : 'Lax'}`,
  ];
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearCookie(
  name: string,
  secure: boolean,
  sameSite: CookieOptions['sameSite'] = 'lax',
): string {
  return serializeCookie(name, '', {
    httpOnly: true,
    sameSite,
    path: '/',
    secure,
    maxAge: 0,
  });
}

function tokenKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'switchboard-token-v1', 'aes-256-gcm', 32),
  );
}

export function sealIssuedToken(secret: string, slip: IssuedSlip): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(slip), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

export function openIssuedToken(
  secret: string,
  value: string,
  now = Date.now(),
): IssuedSlip | undefined {
  if (secret === '') {
    return undefined;
  }
  let packed: Buffer;
  try {
    packed = Buffer.from(value, 'base64url');
  } catch {
    return undefined;
  }
  if (packed.length < 12 + 16 + 2) {
    return undefined;
  }
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);
  let plaintext: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.handover !== 'boolean' ||
    typeof record.exp !== 'number' ||
    !Number.isFinite(record.exp) ||
    record.exp <= now ||
    record.exp > now + TOKEN_TTL_MS + 5_000
  ) {
    return undefined;
  }
  return {
    id: record.id,
    name: record.name,
    token: record.token,
    handover: record.handover,
    exp: record.exp,
  };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string') {
    return '/';
  }
  if (hasControlCharacter(value)) {
    throw new ReturnPathError();
  }
  if (
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\') ||
    value.includes('://') ||
    value.includes('\\')
  ) {
    return '/';
  }
  return value;
}

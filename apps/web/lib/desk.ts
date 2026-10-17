import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DeskFailure } from './ledger';

export const DESK_COOKIE = 'switchboard_desk';
export const FLASH_COOKIE = 'switchboard_flash';
export const THEME_COOKIE = 'switchboard_theme';

const FORM_CSRF_TTL_MS = 2 * 60 * 60 * 1000;

export type CookieOptions = {
  httpOnly: boolean;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
};

export type Flash =
  | { type: 'issued'; id: string; name: string; token: string }
  | { type: 'revoked'; name: string }
  | { type: 'failure'; failure: DeskFailure };

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
    'SameSite=Lax',
  ];
  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: 0,
  });
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

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { DeskFailure } from './ledger';

export const DESK_COOKIE = 'switchboard_desk';
export const FLASH_COOKIE = 'switchboard_flash';
export const THEME_COOKIE = 'switchboard_theme';

const FLASH_TTL_MS = 120_000;

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

type FlashEntry = {
  flash: Flash;
  expires: number;
};

const FLASH_STORE = Symbol.for('switchboard.desk.flashes');

function flashStore(): Map<string, FlashEntry> {
  const host = globalThis as typeof globalThis & {
    [FLASH_STORE]?: Map<string, FlashEntry>;
  };
  // Route handlers and pages are separate bundles, so a module-level Map
  // is not shared. One process-wide store keeps the one-time slip readable.
  host[FLASH_STORE] ??= new Map();
  return host[FLASH_STORE];
}

export function secretsEqual(expected: string, provided: string): boolean {
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(provided).digest();
  return timingSafeEqual(left, right);
}

export function deskSessionValue(secret: string): string {
  return createHmac('sha256', secret)
    .update('switchboard-desk-v1')
    .digest('base64url');
}

export function deskSessionValid(
  secret: string,
  value: string | undefined,
): boolean {
  if (secret === '') {
    return false;
  }
  const expected = createHash('sha256')
    .update(deskSessionValue(secret))
    .digest();
  const actual = createHash('sha256')
    .update(value ?? '')
    .digest();
  return timingSafeEqual(expected, actual);
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

export function safeReturnPath(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || value.length > 2048) {
    return '/';
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\')
  ) {
    return '/';
  }
  if (value.includes('://') || value.includes('\\') || value.includes('\n')) {
    return '/';
  }
  return value;
}

function prune(store: Map<string, FlashEntry>, now: number): void {
  for (const [key, entry] of store) {
    if (entry.expires <= now) {
      store.delete(key);
    }
  }
}

export function stageFlash(flash: Flash): string {
  const store = flashStore();
  const now = Date.now();
  prune(store, now);
  const id = randomBytes(18).toString('base64url');
  store.set(id, { flash, expires: now + FLASH_TTL_MS });
  return id;
}

export function takeFlash(id: string): Flash | undefined {
  const store = flashStore();
  const entry = store.get(id);
  store.delete(id);
  if (entry === undefined || entry.expires <= Date.now()) {
    return undefined;
  }
  return entry.flash;
}

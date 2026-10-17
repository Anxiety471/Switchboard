import { beforeEach, expect, test } from 'vitest';
import { issueFormCsrf } from './desk';
import {
  LOGIN_LIMIT_KEYS,
  deskClientKey,
  loginLimited,
  noteLoginFailure,
  proxyHops,
  resetLoginLimits,
} from './login-limit';
import { handleDeskForm, type DeskFormInput } from './mutations';

const SECRET = 'desk-secret-desk-secret-desk-secret';
const WINDOW_MS = 10 * 60 * 1000;

beforeEach(() => {
  resetLoginLimits();
});

test('a trusted proxy counts the hop from the right', () => {
  expect(proxyHops(undefined)).toBe(1);
  expect(proxyHops('')).toBe(1);
  expect(proxyHops('2')).toBe(2);
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
  ).toBe('fwd:198.51.100.1');
  expect(
    deskClientKey({
      forwardedFor: '203.0.113.20, 203.0.113.10, 198.51.100.1',
      trustProxy: true,
      hops: 2,
    }),
  ).toBe('fwd:203.0.113.10');
  expect(
    deskClientKey({
      forwardedFor: '203.0.113.10',
      trustProxy: true,
      hops: 2,
    }),
  ).toBeUndefined();
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

function lock(key: string, now: number): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    expect(loginLimited(key, now)).toBe(false);
    noteLoginFailure(key, now);
  }
  expect(loginLimited(key, now)).toBe(true);
}

test('a full table evicts an unlocked bucket and never a locked one', () => {
  const now = 1_700_000_000_000;
  for (let index = 0; index < LOGIN_LIMIT_KEYS - 1; index += 1) {
    lock(`locked-${index}`, now);
  }
  noteLoginFailure('unlocked', now);
  expect(loginLimited('unlocked', now)).toBe(false);

  noteLoginFailure('fresh', now);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    noteLoginFailure('unlocked', now);
  }
  expect(loginLimited('unlocked', now)).toBe(false);
  expect(loginLimited('locked-0', now)).toBe(true);
  expect(loginLimited(`locked-${LOGIN_LIMIT_KEYS - 2}`, now)).toBe(true);
});

test('rotating addresses share an overflow bucket once every bucket is locked', () => {
  const now = 1_700_000_000_000;
  for (let index = 0; index < LOGIN_LIMIT_KEYS; index += 1) {
    lock(`locked-${index}`, now);
  }

  for (let index = 0; index < 8; index += 1) {
    expect(loginLimited(`rotating-${index}`, now)).toBe(false);
    noteLoginFailure(`rotating-${index}`, now);
  }
  expect(loginLimited('rotating-8', now)).toBe(true);
  expect(loginLimited('locked-0', now)).toBe(true);
  expect(loginLimited(`locked-${LOGIN_LIMIT_KEYS - 1}`, now)).toBe(true);

  for (let index = 0; index < 40; index += 1) {
    noteLoginFailure(`more-${index}`, now);
    expect(loginLimited(`more-${index}`, now)).toBe(true);
  }

  expect(loginLimited('after-window', now + WINDOW_MS - 1)).toBe(true);
  expect(loginLimited('after-window', now + WINDOW_MS)).toBe(false);
});

test('an overflow lock refuses the next new address at the desk', async () => {
  const now = 1_700_000_000_000;
  for (let index = 0; index < LOGIN_LIMIT_KEYS; index += 1) {
    lock(`locked-${index}`, now);
  }
  for (let index = 0; index < 8; index += 1) {
    noteLoginFailure(`rotating-${index}`, now);
  }

  const csrf = issueFormCsrf(SECRET, now);
  const directory = {
    session: undefined as { id: string; csrfToken: string } | undefined,
    openSession() {
      this.session = {
        id: 'session-id-session-id-session-id-sess',
        csrfToken: 'csrf-token-csrf-token-csrf-token-csrf',
      };
      return Promise.resolve({
        ok: true as const,
        value: this.session,
      });
    },
    closeSession() {
      return Promise.resolve({ ok: true as const, value: true as const });
    },
    readSession() {
      return Promise.resolve({
        ok: false as const,
        failure: 'not_found' as const,
      });
    },
    saveNotice() {
      return Promise.resolve({
        ok: false as const,
        failure: 'not_found' as const,
      });
    },
    confirmHandover() {
      return Promise.resolve({ ok: true as const, value: true as const });
    },
    discardPending() {
      return Promise.resolve({ ok: true as const, value: true as const });
    },
  };
  const form = new FormData();
  form.set('intent', 'login');
  form.set('password', 'nope');
  form.set('csrf', csrf);
  const input: DeskFormInput = {
    env: {
      DASHBOARD_SECRET: SECRET,
      SWITCHBOARD_URL: 'http://127.0.0.1:3001',
    },
    secure: false,
    origin: 'http://127.0.0.1:3000',
    host: '127.0.0.1:3000',
    sessionId: undefined,
    tokenCookie: undefined,
    clientKey: 'rotating-next',
    now,
    wrongGuessDelayMs: 0,
    directory,
  };
  expect(await handleDeskForm(form, input)).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(directory.session).toBeUndefined();
  expect(loginLimited('locked-0', now)).toBe(true);
});

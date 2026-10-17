import { spawnSync } from 'node:child_process';
import { beforeEach, expect, test, vi } from 'vitest';
import { issueFormCsrf } from './desk';
import {
  LOGIN_LIMIT_KEYS,
  deskClientKey,
  loginLimited,
  noteLoginFailure,
  proxyHops,
  resetLoginLimits,
} from './login-limit';
import { enforceProxyHops } from './enforce-proxy-hops';
import { handleDeskForm, type DeskFormInput } from './mutations';

const SECRET = 'desk-secret-desk-secret-desk-secret';
const WINDOW_MS = 10 * 60 * 1000;

beforeEach(() => {
  resetLoginLimits();
});

test('a trusted proxy counts the hop from the right', () => {
  expect(proxyHops(undefined)).toBe(1);
  expect(proxyHops('')).toBe(1);
  expect(proxyHops(' 2 ')).toBe(2);
  expect(proxyHops('2')).toBe(2);
  const unset = { ...process.env };
  delete unset.TRUST_PROXY_HOPS;
  enforceProxyHops(unset);
  enforceProxyHops({ ...process.env, TRUST_PROXY_HOPS: '2' });
  for (const value of ['0', '-1', '1.5', 'true', '01']) {
    expect(() => proxyHops(value)).toThrow(
      /^TRUST_PROXY_HOPS must be a positive integer$/,
    );
  }
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
  ).toBe('fwd:unparsed');
  expect(
    deskClientKey({
      forwardedFor: ' ',
      trustProxy: true,
    }),
  ).toBe('fwd:unparsed');
  expect(deskClientKey({ forwardedFor: null, trustProxy: true })).toBe(
    'fwd:unparsed',
  );
});

test('an invalid hop count prints one line and exits non-zero', () => {
  const moduleUrl = new URL('./login-limit.ts', import.meta.url);
  const source = `import { ProxyHopsError, proxyHops } from ${JSON.stringify(moduleUrl.href)};
try {
  proxyHops('0');
} catch (error) {
  if (error instanceof ProxyHopsError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', source],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe(
    'TRUST_PROXY_HOPS must be a positive integer',
  );

  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as typeof process.exit);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(() =>
      enforceProxyHops({ ...process.env, TRUST_PROXY_HOPS: '-1' }),
    ).toThrow('exit');
    expect(logged).toHaveBeenCalledWith(
      'TRUST_PROXY_HOPS must be a positive integer',
    );
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    exit.mockRestore();
    logged.mockRestore();
  }
});

test('ipv6 clients in one /64 share a bucket key', () => {
  const prefix = '2001:db8:1:2';
  for (let index = 1; index <= 1024; index += 1) {
    expect(
      deskClientKey({
        forwardedFor: `203.0.113.1, ${prefix}::${index.toString(16)}`,
        trustProxy: true,
      }),
    ).toBe(`fwd:${prefix}`);
  }
  expect(
    deskClientKey({
      forwardedFor: '2001:0DB8:0001:0002:ffff:0:0:2',
      trustProxy: true,
    }),
  ).toBe(`fwd:${prefix}`);
  expect(
    deskClientKey({
      forwardedFor: '2001:DB8:1:2:ffff::2',
      trustProxy: true,
    }),
  ).toBe(`fwd:${prefix}`);
  expect(
    deskClientKey({
      forwardedFor: '2001:db8:1:3::1',
      trustProxy: true,
    }),
  ).toBe('fwd:2001:db8:1:3');
  expect(
    deskClientKey({
      forwardedFor: '198.51.100.9',
      trustProxy: true,
    }),
  ).toBe('fwd:198.51.100.9');
  expect(
    deskClientKey({
      forwardedFor: 'gggg::1',
      trustProxy: true,
    }),
  ).toBe('fwd:unparsed');

  const now = 1_700_000_000_000;
  const shared = `fwd:${prefix}`;
  lock(shared, now);
  expect(loginLimited(shared, now)).toBe(true);
  expect(loginLimited('fwd:2001:db8:1:3', now)).toBe(false);
});

test('forwarded addresses are normalized and unparseable ones share a bucket', () => {
  expect(
    deskClientKey({
      forwardedFor: '::ffff:203.0.113.77',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.77');
  expect(
    deskClientKey({
      forwardedFor: '::FFFF:cb00:714d',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.77');
  expect(
    deskClientKey({
      forwardedFor: '0:0:0:0:0:ffff:203.0.113.77',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.77');
  expect(
    deskClientKey({
      forwardedFor: '203.0.113.78:4711',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.78');
  expect(
    deskClientKey({
      forwardedFor: '[2001:db8:9::1]:443',
      trustProxy: true,
    }),
  ).toBe('fwd:2001:db8:9:0');
  expect(
    deskClientKey({
      forwardedFor: '2001:db8:9:0:ffff::2',
      trustProxy: true,
    }),
  ).toBe('fwd:2001:db8:9:0');
  expect(
    deskClientKey({
      forwardedFor: 'fe80::1%eth0',
      trustProxy: true,
    }),
  ).toBe('fwd:fe80:0:0:0');
  expect(
    deskClientKey({
      forwardedFor: 'FE80::2%eth1',
      trustProxy: true,
    }),
  ).toBe('fwd:fe80:0:0:0');
  expect(
    deskClientKey({
      forwardedFor: 'garbage, 203.0.113.10',
      trustProxy: true,
    }),
  ).toBe('fwd:203.0.113.10');
  for (const forwardedFor of ['garbage', '!!!', 'gggg::1', null, ' ']) {
    expect(deskClientKey({ forwardedFor, trustProxy: true })).toBe(
      'fwd:unparsed',
    );
  }

  const now = 1_700_000_000_000;
  lock('fwd:unparsed', now);
  expect(loginLimited('fwd:unparsed', now)).toBe(true);
  expect(loginLimited('fwd:203.0.113.77', now)).toBe(false);
  expect(loginLimited('fwd:fe80:0:0:0', now)).toBe(false);
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

test('an overflow lock limits a wrong key and still signs in a correct key', async () => {
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

  form.set('password', SECRET);
  const signedIn = await handleDeskForm(form, {
    ...input,
    clientKey: 'brand-new',
  });
  expect(signedIn).toMatchObject({ kind: 'redirect', location: '/' });
  expect(directory.session).toBeDefined();
  expect(loginLimited('locked-0', now)).toBe(true);
  expect(loginLimited('still-new', now)).toBe(true);

  form.set('password', 'nope');
  expect(
    await handleDeskForm(form, { ...input, clientKey: 'another-new' }),
  ).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
});

test('overflow outcomes take the same time apart from the session cookie', async () => {
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
      return new Promise<{
        ok: true;
        value: { id: string; csrfToken: string };
      }>((resolve) => {
        setTimeout(() => {
          this.session = {
            id: 'session-id-session-id-session-id-sess',
            csrfToken: 'csrf-token-csrf-token-csrf-token-csrf',
          };
          resolve({ ok: true, value: this.session });
        }, 200);
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
    clientKey: 'overflow-wrong',
    now,
    wrongGuessDelayMs: 500,
    directory,
  };
  const wrongStarted = performance.now();
  const wrong = await handleDeskForm(
    (() => {
      const form = new FormData();
      form.set('intent', 'login');
      form.set('password', 'nope');
      form.set('csrf', csrf);
      return form;
    })(),
    input,
  );
  const wrongElapsed = performance.now() - wrongStarted;
  const rightStarted = performance.now();
  const right = await handleDeskForm(
    (() => {
      const form = new FormData();
      form.set('intent', 'login');
      form.set('password', SECRET);
      form.set('csrf', csrf);
      return form;
    })(),
    { ...input, clientKey: 'overflow-right' },
  );
  const rightElapsed = performance.now() - rightStarted;
  expect(wrong).toEqual({
    kind: 'redirect',
    location: '/?error=limited',
    cookies: [],
  });
  expect(right).toMatchObject({ kind: 'redirect', location: '/' });
  expect(directory.session).toBeDefined();
  expect(wrongElapsed).toBeGreaterThanOrEqual(450);
  expect(rightElapsed).toBeGreaterThanOrEqual(450);
  expect(rightElapsed).toBeLessThan(wrongElapsed + 120);
  expect(loginLimited('locked-0', now)).toBe(true);
});

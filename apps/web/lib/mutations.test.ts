import { expect, test } from 'vitest';
import {
  DESK_COOKIE,
  FLASH_COOKIE,
  THEME_COOKIE,
  deskSessionValid,
  takeFlash,
} from './desk';
import { handleDeskForm, type CookieJar, type LedgerWrites } from './mutations';

const SECRET = 'desk-secret';

function env(): Record<string, string | undefined> {
  return {
    DASHBOARD_SECRET: SECRET,
    SWITCHBOARD_URL: 'http://127.0.0.1:3001',
  };
}

function jar(): CookieJar & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get(name) {
      return values.get(name);
    },
    set(name, value) {
      values.set(name, value);
    },
    delete(name) {
      values.delete(name);
    },
  };
}

function writes(): LedgerWrites & {
  calls: string[];
} {
  return {
    calls: [],
    registerAgent() {
      this.calls.push('register');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', token: 'issued-token' },
      });
    },
    issueAgentToken() {
      this.calls.push('issue');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', token: 'rotated-token' },
      });
    },
    revokeAgentToken() {
      this.calls.push('revoke');
      return Promise.resolve({
        ok: true,
        value: { id: 'agent-id', name: 'alpha', tokenRevoked: true },
      });
    },
  };
}

test('login, theme, and logout stay on the desk', async () => {
  const cookies = jar();
  const wrong = new FormData();
  wrong.set('intent', 'login');
  wrong.set('password', 'nope');
  expect(
    await handleDeskForm(wrong, { env: env(), jar: cookies, secure: false }),
  ).toBe('/');
  expect(cookies.values.has(DESK_COOKIE)).toBe(false);
  const flashId = cookies.values.get(FLASH_COOKIE);
  expect(flashId).toBeDefined();
  expect(takeFlash(flashId ?? '')).toEqual({
    type: 'failure',
    failure: 'unauthorized',
  });

  const right = new FormData();
  right.set('intent', 'login');
  right.set('password', SECRET);
  expect(
    await handleDeskForm(right, { env: env(), jar: cookies, secure: false }),
  ).toBe('/');
  expect(deskSessionValid(SECRET, cookies.values.get(DESK_COOKIE))).toBe(true);
  expect(cookies.values.get(DESK_COOKIE)).not.toContain(SECRET);

  const theme = new FormData();
  theme.set('intent', 'theme');
  theme.set('theme', 'dark');
  theme.set('returnTo', '//evil.example');
  expect(
    await handleDeskForm(theme, { env: env(), jar: cookies, secure: true }),
  ).toBe('/');
  expect(cookies.values.get(THEME_COOKIE)).toBe('dark');

  const logout = new FormData();
  logout.set('intent', 'logout');
  expect(
    await handleDeskForm(logout, { env: env(), jar: cookies, secure: false }),
  ).toBe('/');
  expect(cookies.values.has(DESK_COOKIE)).toBe(false);
});

test('register, issue, and revoke require a session and show a token once', async () => {
  const cookies = jar();
  const client = writes();
  const register = new FormData();
  register.set('intent', 'register');
  register.set('name', 'alpha');
  register.set('returnTo', '/?inbox=keep');
  expect(
    await handleDeskForm(register, {
      env: env(),
      jar: cookies,
      secure: false,
      writes: client,
    }),
  ).toBe('/');
  expect(client.calls).toEqual([]);

  const login = new FormData();
  login.set('intent', 'login');
  login.set('password', SECRET);
  await handleDeskForm(login, { env: env(), jar: cookies, secure: false });

  expect(
    await handleDeskForm(register, {
      env: env(),
      jar: cookies,
      secure: false,
      writes: client,
    }),
  ).toBe('/?inbox=keep');
  expect(client.calls).toEqual(['register']);
  const issued = takeFlash(cookies.values.get(FLASH_COOKIE) ?? '');
  expect(issued).toEqual({
    type: 'issued',
    id: 'agent-id',
    name: 'alpha',
    token: 'issued-token',
  });
  expect(takeFlash(cookies.values.get(FLASH_COOKIE) ?? '')).toBeUndefined();

  const conflict = writes();
  conflict.registerAgent = () =>
    Promise.resolve({ ok: false, failure: 'conflict' });
  const again = new FormData();
  again.set('intent', 'register');
  again.set('name', 'alpha');
  await handleDeskForm(again, {
    env: env(),
    jar: cookies,
    secure: false,
    writes: conflict,
  });
  expect(takeFlash(cookies.values.get(FLASH_COOKIE) ?? '')).toEqual({
    type: 'failure',
    failure: 'conflict',
  });

  const issue = new FormData();
  issue.set('intent', 'issue');
  issue.set('id', '00000000-0000-4000-8000-000000000001');
  await handleDeskForm(issue, {
    env: env(),
    jar: cookies,
    secure: false,
    writes: client,
  });
  expect(client.calls).toContain('issue');
  expect(takeFlash(cookies.values.get(FLASH_COOKIE) ?? '')).toMatchObject({
    type: 'issued',
    token: 'rotated-token',
  });

  const revoke = new FormData();
  revoke.set('intent', 'revoke');
  revoke.set('id', '00000000-0000-4000-8000-000000000001');
  await handleDeskForm(revoke, {
    env: env(),
    jar: cookies,
    secure: false,
    writes: client,
  });
  expect(takeFlash(cookies.values.get(FLASH_COOKIE) ?? '')).toEqual({
    type: 'revoked',
    name: 'alpha',
  });
  expect(JSON.stringify(client.calls)).not.toContain(SECRET);
});

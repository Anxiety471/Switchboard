import { beforeEach, expect, test, vi } from 'vitest';
import { deskSessionValid, takeFlash } from '../../lib/desk';
import { POST } from './route';

const store = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = store.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    }),
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

const SECRET = 'desk-secret';

beforeEach(() => {
  store.clear();
  process.env.DASHBOARD_SECRET = SECRET;
  process.env.SWITCHBOARD_URL = 'http://127.0.0.1:3001';
});

function request(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return new Request('http://127.0.0.1/desk', { method: 'POST', body: form });
}

test('POST /desk logs in and stores a session that is not the secret', async () => {
  await expect(
    POST(request({ intent: 'login', password: 'nope' })),
  ).rejects.toThrow('REDIRECT:/');
  expect(store.has('switchboard_desk')).toBe(false);
  const denied = store.get('switchboard_flash');
  expect(takeFlash(denied ?? '')).toEqual({
    type: 'failure',
    failure: 'unauthorized',
  });

  await expect(
    POST(request({ intent: 'login', password: SECRET })),
  ).rejects.toThrow('REDIRECT:/');
  const session = store.get('switchboard_desk');
  expect(deskSessionValid(SECRET, session)).toBe(true);
  expect(session).not.toContain(SECRET);

  await expect(
    POST(
      request({
        intent: 'theme',
        theme: 'dark',
        returnTo: '/?inbox=00000000-0000-4000-8000-000000000001',
      }),
    ),
  ).rejects.toThrow('REDIRECT:/?inbox=00000000-0000-4000-8000-000000000001');
  expect(store.get('switchboard_theme')).toBe('dark');
});

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { deskSessionValue } from '../lib/desk';
import { loadLedger } from '../lib/ledger';
import HomePage from './page';

const store = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = store.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

vi.mock('../lib/ledger.js', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/ledger.js')>(
      '../lib/ledger.js',
    );
  return {
    ...actual,
    loadLedger: vi.fn(),
  };
});

const SECRET = 'desk-secret';

beforeEach(() => {
  store.clear();
  vi.mocked(loadLedger).mockReset();
  delete process.env.DASHBOARD_SECRET;
  delete process.env.SWITCHBOARD_URL;
});

test('the home route keeps the desk locked until the session and API are ready', async () => {
  const locked = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({}) }),
  );
  expect(locked).toContain('Switchboard');
  expect(locked).toContain('Set DASHBOARD_SECRET and SWITCHBOARD_URL');
  expect(locked).not.toContain('Desk key');

  process.env.DASHBOARD_SECRET = SECRET;
  process.env.SWITCHBOARD_URL = 'http://127.0.0.1:3001';
  const login = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({}) }),
  );
  expect(login).toContain('Desk key');
  expect(login).not.toContain('01 Register');
  expect(vi.mocked(loadLedger)).not.toHaveBeenCalled();

  store.set('switchboard_desk', deskSessionValue(SECRET));
  vi.mocked(loadLedger).mockResolvedValue({
    ok: false,
    failure: 'database_unavailable',
  });
  const down = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({}) }),
  );
  expect(down).toContain('The database is unavailable (HTTP 503).');
  expect(down).not.toContain(SECRET);
  expect(vi.mocked(loadLedger)).toHaveBeenCalledOnce();
});

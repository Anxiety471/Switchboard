import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, test, vi } from 'vitest';
import { loadLedger, readDeskSession } from '../lib/ledger';
import HomePage from './page';

const store = new Map<string, string>();
const SECRET = 'desk-secret-desk-secret-desk-secret';
const SESSION_ID = 'a'.repeat(43);

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
    await vi.importActual<typeof import('../lib/ledger')>('../lib/ledger');
  return {
    ...actual,
    loadLedger: vi.fn(),
    readDeskSession: vi.fn(),
    takeDeskNotice: vi.fn(),
  };
});

beforeEach(() => {
  store.clear();
  vi.mocked(loadLedger).mockReset();
  vi.mocked(readDeskSession).mockReset();
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

  process.env.DASHBOARD_SECRET = 'too-short';
  process.env.SWITCHBOARD_URL = 'http://127.0.0.1:3001';
  const short = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({}) }),
  );
  expect(short).toContain('Set DASHBOARD_SECRET and SWITCHBOARD_URL');

  process.env.DASHBOARD_SECRET = SECRET;
  const login = renderToStaticMarkup(
    await HomePage({
      searchParams: Promise.resolve({ error: 'unauthorized' }),
    }),
  );
  expect(login).toContain('Desk key');
  expect(login).toContain('That desk key was not accepted.');
  expect(login).toContain('name="csrf"');
  expect(login).not.toContain('01 Register');
  expect(login).not.toContain('error=unauthorized');
  expect(vi.mocked(loadLedger)).not.toHaveBeenCalled();
  expect(vi.mocked(readDeskSession)).not.toHaveBeenCalled();

  const unknown = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({ error: 'unknown' }) }),
  );
  expect(unknown).toContain('The result is unknown.');
  expect(unknown).not.toContain('left unchanged');

  store.set('switchboard_desk', SESSION_ID);
  vi.mocked(readDeskSession).mockResolvedValue({
    ok: true,
    value: { csrfToken: 'c'.repeat(43) },
  });
  vi.mocked(loadLedger).mockResolvedValue({
    ok: false,
    failure: 'database_unavailable',
  });
  const down = renderToStaticMarkup(
    await HomePage({ searchParams: Promise.resolve({}) }),
  );
  expect(down).toContain('The database is unavailable (HTTP 503).');
  expect(down).not.toContain('Desk key');
  expect(down).not.toContain(SECRET);
  expect(down).toContain(`value="${'c'.repeat(43)}"`);
  expect(vi.mocked(readDeskSession)).toHaveBeenCalledOnce();
  expect(vi.mocked(loadLedger)).toHaveBeenCalledOnce();
});

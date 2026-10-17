import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { beforeEach, expect, test } from 'vitest';
import { issueFormCsrf } from '../../lib/desk';
import { resetLoginLimits } from '../../lib/login-limit';
import { POST } from './route';

const SECRET = 'desk-secret-desk-secret-desk-secret';
const SESSION_ID = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);

beforeEach(() => {
  resetLoginLimits();
  process.env.DASHBOARD_SECRET = SECRET;
  process.env.SWITCHBOARD_URL = 'http://127.0.0.1:9';
  delete process.env.COOKIE_SECURE;
});

function request(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return new Request('http://127.0.0.1:3000/desk', {
    method: 'POST',
    body: form,
    headers,
  });
}

function originHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    origin: 'http://127.0.0.1:3000',
    ...extra,
  };
}

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          }),
      });
    });
  });
}

test('POST /desk returns 303 with cookie flags and does not take Secure from a proxy header', async () => {
  let current: { id: string; csrfToken: string } | undefined;
  const server = await listen((incoming, response) => {
    const secret = incoming.headers['x-dashboard-secret'];
    if (secret !== SECRET) {
      response.writeHead(401).end('{}');
      return;
    }
    if (incoming.url === '/dashboard/sessions' && incoming.method === 'POST') {
      current = { id: SESSION_ID, csrfToken: CSRF };
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(current));
      return;
    }
    if (
      incoming.method === 'GET' &&
      incoming.url === `/dashboard/sessions/${SESSION_ID}`
    ) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ csrfToken: CSRF }));
      return;
    }
    if (
      incoming.method === 'DELETE' &&
      incoming.url === `/dashboard/sessions/${SESSION_ID}`
    ) {
      current = undefined;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end('{}');
  });
  process.env.SWITCHBOARD_URL = server.url;
  try {
    const csrf = issueFormCsrf(SECRET);
    const denied = await POST(
      request(
        { intent: 'login', password: 'nope', csrf },
        originHeaders({ 'x-forwarded-proto': 'https' }),
      ),
    );
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/?error=unauthorized');
    expect(denied.headers.getSetCookie()).toEqual([]);

    const loggedIn = await POST(
      request(
        { intent: 'login', password: SECRET, csrf },
        originHeaders({ 'x-forwarded-proto': 'https' }),
      ),
    );
    expect(loggedIn.status).toBe(303);
    expect(loggedIn.headers.get('location')).toBe('/');
    const setCookie = loggedIn.headers.getSetCookie().join('\n');
    expect(setCookie).toContain(`switchboard_desk=${SESSION_ID}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain(SECRET);

    const themed = await POST(
      request(
        {
          intent: 'theme',
          theme: 'dark',
          returnTo: '/?inbox=00000000-0000-4000-8000-000000000001',
          csrf: CSRF,
        },
        originHeaders({
          cookie: `switchboard_desk=${SESSION_ID}`,
          'x-forwarded-proto': 'https',
        }),
      ),
    );
    expect(themed.status).toBe(303);
    expect(themed.headers.get('location')).toBe(
      '/?inbox=00000000-0000-4000-8000-000000000001',
    );
    expect(themed.headers.get('set-cookie')).toContain(
      'switchboard_theme=dark',
    );
    expect(themed.headers.get('set-cookie')).not.toContain('Secure');

    process.env.COOKIE_SECURE = 'true';
    const secured = await POST(
      request(
        { intent: 'logout', csrf: CSRF },
        originHeaders({ cookie: `switchboard_desk=${SESSION_ID}` }),
      ),
    );
    expect(secured.status).toBe(303);
    expect(secured.headers.get('location')).toBe('/');
    const cleared = secured.headers.getSetCookie().join('\n');
    expect(cleared).toContain('Secure');
    expect(cleared).toContain('switchboard_desk=');
    expect(cleared).toContain('Max-Age=0');
  } finally {
    await server.close();
  }
});

test('POST /desk rejects a foreign origin, a missing csrf token, and a control character in returnTo', async () => {
  const csrf = issueFormCsrf(SECRET);
  const foreign = await POST(
    request(
      { intent: 'login', password: SECRET, csrf },
      { origin: 'https://evil.example' },
    ),
  );
  expect(foreign.status).toBe(403);

  const missing = await POST(
    request({ intent: 'login', password: SECRET }, originHeaders()),
  );
  expect(missing.status).toBe(403);

  const tab = await POST(
    request(
      { intent: 'theme', theme: 'dark', returnTo: '/\t', csrf },
      originHeaders(),
    ),
  );
  expect(tab.status).toBe(400);

  const carriage = await POST(
    request(
      { intent: 'theme', theme: 'dark', returnTo: '/ok\r', csrf },
      originHeaders(),
    ),
  );
  expect(carriage.status).toBe(400);
});

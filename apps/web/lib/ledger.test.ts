import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { expect, test } from 'vitest';
import { loadLedger, registerAgent, type LedgerSelection } from './ledger';

const selection: LedgerSelection = {
  inboxId: undefined,
  historyAfter: undefined,
  inboxAfter: undefined,
};

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

test('maps API failures without echoing the desk secret', async () => {
  const secret = 'desk-secret';
  let seenUrl = '';
  let seenSecret = '';
  const server = await listen((request, response) => {
    seenUrl = request.url ?? '';
    seenSecret = request.headers['x-dashboard-secret']?.toString() ?? '';
    if (request.url === '/dashboard/agents' && request.method === 'POST') {
      response.writeHead(409, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'name already registered' }));
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'database_unavailable' }));
  });
  try {
    const config = { url: server.url, secret };
    const loaded = await loadLedger(config, selection);
    expect(loaded).toEqual({ ok: false, failure: 'database_unavailable' });
    expect(seenSecret).toBe(secret);
    expect(seenUrl).toBe('/dashboard/agents');
    expect(JSON.stringify(loaded)).not.toContain(secret);

    const registered = await registerAgent(config, 'alpha');
    expect(registered).toEqual({ ok: false, failure: 'conflict' });
    expect(JSON.stringify(registered)).not.toContain(secret);
  } finally {
    await server.close();
  }
});

test('rejects agent payloads that include a token and reports an unreachable API', async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        agents: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'alpha',
            online: true,
            lastSeenAt: null,
            createdAt: '2026-10-17T12:00:00.000Z',
            tokenRevoked: false,
            token: 'should-not-pass',
          },
        ],
      }),
    );
  });
  try {
    const loaded = await loadLedger(
      { url: server.url, secret: 'desk-secret' },
      selection,
    );
    expect(loaded).toEqual({ ok: false, failure: 'failed' });
    expect(JSON.stringify(loaded)).not.toContain('should-not-pass');
  } finally {
    await server.close();
  }

  const closed = await listen((_request, response) => {
    response.end();
  });
  const closedUrl = closed.url;
  await closed.close();
  const unreachable = await loadLedger(
    { url: closedUrl, secret: 'desk-secret' },
    selection,
  );
  expect(unreachable).toEqual({ ok: false, failure: 'unreachable' });
});

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import type {
  DashboardAgent,
  HistoryPage,
  InboxPage,
  RegisteredAgent,
} from '@switchboard/shared';
import { buildApp } from './app.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

const SECRET = 'desk-secret';
const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const app = buildApp(databaseUrl, { dashboardSecret: SECRET });
const admin = new Client({ connectionString: databaseUrl });

beforeAll(async () => {
  await admin.connect();
  await app.ready();
  await app.migrationsReady;
});

beforeEach(async () => {
  await admin.query('TRUNCATE agents, dashboard_sessions CASCADE');
});

afterAll(async () => {
  await admin.end();
  await app.close();
});

function desk(secret = SECRET): { 'x-dashboard-secret': string } {
  return { 'x-dashboard-secret': secret };
}

async function register(name: string): Promise<RegisteredAgent> {
  const response = await app.inject({
    method: 'POST',
    url: '/dashboard/agents',
    headers: desk(),
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

test('dashboard routes reject a missing or wrong secret and do not echo it', async () => {
  const wrong = 'wrong-desk-key';
  const routes = [
    { method: 'GET' as const, url: '/dashboard/agents' },
    { method: 'GET' as const, url: '/dashboard/messages' },
    {
      method: 'GET' as const,
      url: '/dashboard/agents/00000000-0000-4000-8000-000000000001/inbox',
    },
    {
      method: 'POST' as const,
      url: '/dashboard/agents',
      payload: { name: 'alpha' },
    },
    {
      method: 'POST' as const,
      url: '/dashboard/agents/00000000-0000-4000-8000-000000000001/token',
    },
    {
      method: 'POST' as const,
      url: '/dashboard/agents/00000000-0000-4000-8000-000000000001/token/revoke',
    },
    { method: 'POST' as const, url: '/dashboard/sessions' },
    {
      method: 'GET' as const,
      url: `/dashboard/sessions/${'a'.repeat(43)}`,
    },
    {
      method: 'DELETE' as const,
      url: `/dashboard/sessions/${'a'.repeat(43)}`,
    },
    {
      method: 'POST' as const,
      url: `/dashboard/sessions/${'a'.repeat(43)}/notices`,
      payload: { type: 'revoked', name: 'alpha' },
    },
    {
      method: 'POST' as const,
      url: `/dashboard/sessions/${'a'.repeat(43)}/notices/${'b'.repeat(43)}/take`,
    },
  ];
  for (const route of routes) {
    const missing = await app.inject(route);
    expect(missing.statusCode, route.url).toBe(401);
    expect(missing.json()).toEqual({ error: 'unauthorized' });
    expect(missing.body).not.toContain(SECRET);

    const rejected = await app.inject({ ...route, headers: desk(wrong) });
    expect(rejected.statusCode, route.url).toBe(401);
    expect(rejected.json()).toEqual({ error: 'unauthorized' });
    expect(rejected.body).not.toContain(SECRET);
    expect(rejected.body).not.toContain(wrong);
  }

  const closed = buildApp(databaseUrl, { dashboardSecret: '' });
  try {
    const response = await closed.inject({
      method: 'GET',
      url: '/dashboard/agents',
      headers: desk(''),
    });
    expect(response.statusCode).toBe(401);
  } finally {
    await closed.close();
  }
});

test('an agent bearer cannot open the dashboard, and the desk key cannot act as an agent', async () => {
  const alpha = await register('alpha');
  const stamped = await admin.query<{ last_seen_at: Date | null }>(
    'SELECT last_seen_at FROM agents WHERE id = $1',
    [alpha.id],
  );
  const asAgent = await app.inject({
    method: 'GET',
    url: '/dashboard/agents',
    headers: { authorization: `Bearer ${alpha.token}` },
  });
  expect(asAgent.statusCode).toBe(401);
  expect(asAgent.body).not.toContain(alpha.token);
  const untouched = await admin.query<{ last_seen_at: Date | null }>(
    'SELECT last_seen_at FROM agents WHERE id = $1',
    [alpha.id],
  );
  expect(untouched.rows[0]?.last_seen_at).toEqual(
    stamped.rows[0]?.last_seen_at,
  );

  const asDesk = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: desk(),
  });
  expect(asDesk.statusCode).toBe(401);
  expect(asDesk.body).not.toContain(SECRET);
  expect(asDesk.body).not.toContain(alpha.token);
});

test('dashboard registration keeps the public registration secret in force', async () => {
  const guarded = buildApp(databaseUrl, {
    dashboardSecret: SECRET,
    registrationSecret: 'reg-secret',
  });
  try {
    await guarded.migrationsReady;
    const publicPost = await guarded.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'alpha' },
    });
    expect(publicPost.statusCode).toBe(401);

    const withRegistration = await guarded.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'x-registration-secret': 'reg-secret' },
      payload: { name: 'alpha' },
    });
    expect(withRegistration.statusCode).toBe(201);

    const deskOnly = await guarded.inject({
      method: 'POST',
      url: '/dashboard/agents',
      headers: desk(),
      payload: { name: 'beta' },
    });
    expect(deskOnly.statusCode).toBe(201);
    expect(deskOnly.body).not.toContain('reg-secret');

    const registrationOnDesk = await guarded.inject({
      method: 'POST',
      url: '/dashboard/agents',
      headers: { 'x-registration-secret': 'reg-secret' },
      payload: { name: 'gamma' },
    });
    expect(registrationOnDesk.statusCode).toBe(401);
    expect(registrationOnDesk.body).not.toContain('reg-secret');
  } finally {
    await guarded.close();
  }
});

test('GET /dashboard/agents reports status without moving last_seen', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  await admin.query(
    `UPDATE agents
     SET last_seen_at = clock_timestamp() - interval '30 seconds'
     WHERE id = $1`,
    [beta.id],
  );
  const before = await admin.query<{ name: string; last_seen_at: Date | null }>(
    'SELECT name, last_seen_at FROM agents ORDER BY name',
  );

  const response = await app.inject({
    method: 'GET',
    url: '/dashboard/agents',
    headers: desk(),
  });
  expect(response.statusCode).toBe(200);
  const listed = response.json() as { agents: DashboardAgent[] };
  expect(listed.agents.map((agent) => agent.name)).toEqual(['alpha', 'beta']);
  expect(listed.agents[0]).toMatchObject({
    id: alpha.id,
    name: 'alpha',
    online: false,
    lastSeenAt: null,
    tokenRevoked: false,
  });
  expect(listed.agents[1]).toMatchObject({
    id: beta.id,
    online: true,
    tokenRevoked: false,
  });
  expect(listed.agents[0]?.createdAt).toEqual(expect.any(String));
  expect(JSON.stringify(listed)).not.toContain(alpha.token);
  expect(JSON.stringify(listed)).not.toContain(beta.token);

  const after = await admin.query<{ name: string; last_seen_at: Date | null }>(
    'SELECT name, last_seen_at FROM agents ORDER BY name',
  );
  expect(
    after.rows.map((row) => row.last_seen_at?.toISOString() ?? null),
  ).toEqual(before.rows.map((row) => row.last_seen_at?.toISOString() ?? null));

  await admin.query(
    `UPDATE agents
     SET last_seen_at = clock_timestamp() - interval '61 seconds'
     WHERE id = $1`,
    [beta.id],
  );
  const stale = await app.inject({
    method: 'GET',
    url: '/dashboard/agents',
    headers: desk(),
  });
  const staleBeta = (stale.json() as { agents: DashboardAgent[] }).agents.find(
    (agent) => agent.id === beta.id,
  );
  expect(staleBeta?.online).toBe(false);
  expect(staleBeta?.lastSeenAt).toEqual(expect.any(String));
});

test('POST /dashboard/agents stores only a hash and rejects duplicates', async () => {
  const created = await register('alpha');
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const stored = await admin.query<{
    token_hash: Buffer;
    token_revoked: boolean;
  }>('SELECT token_hash, token_revoked FROM agents WHERE id = $1', [
    created.id,
  ]);
  const row = stored.rows[0];
  expect(row?.token_revoked).toBe(false);
  expect(
    Buffer.from(row?.token_hash ?? Buffer.alloc(0)).equals(
      createHash('sha256').update(created.token).digest(),
    ),
  ).toBe(true);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/dashboard/agents',
    headers: desk(),
    payload: { name: 'Alpha' },
  });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({ error: 'name already registered' });
  expect(duplicate.body).not.toContain(created.token);

  const invalid = await app.inject({
    method: 'POST',
    url: '/dashboard/agents',
    headers: desk(),
    payload: { name: 'has space' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: 'invalid request' });
});

test('issuing a token replaces it and revoke signs the agent out', async () => {
  const created = await register('alpha');
  const first = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: { authorization: `Bearer ${created.token}` },
  });
  expect(first.statusCode).toBe(200);

  const issued = await app.inject({
    method: 'POST',
    url: `/dashboard/agents/${created.id}/token`,
    headers: desk(),
  });
  expect(issued.statusCode).toBe(201);
  const next = issued.json() as RegisteredAgent;
  expect(next.id).toBe(created.id);
  expect(next.token).not.toBe(created.token);
  expect(issued.body).not.toContain(SECRET);

  const retired = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: { authorization: `Bearer ${created.token}` },
  });
  expect(retired.statusCode).toBe(401);
  const active = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: { authorization: `Bearer ${next.token}` },
  });
  expect(active.statusCode).toBe(200);

  const revoked = await app.inject({
    method: 'POST',
    url: `/dashboard/agents/${created.id}/token/revoke`,
    headers: desk(),
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json()).toEqual({
    id: created.id,
    name: 'alpha',
    tokenRevoked: true,
  });
  expect(revoked.body).not.toContain(next.token);
  expect(revoked.body).not.toContain(created.token);
  const locked = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: { authorization: `Bearer ${next.token}` },
  });
  expect(locked.statusCode).toBe(401);
  const seen = await admin.query<{ last_seen_at: Date }>(
    'SELECT last_seen_at FROM agents WHERE id = $1',
    [created.id],
  );
  const frozen = seen.rows[0]?.last_seen_at.toISOString();
  const listed = await app.inject({
    method: 'GET',
    url: '/dashboard/agents',
    headers: desk(),
  });
  expect(
    (listed.json() as { agents: DashboardAgent[] }).agents[0],
  ).toMatchObject({
    tokenRevoked: true,
  });
  const still = await admin.query<{ last_seen_at: Date }>(
    'SELECT last_seen_at FROM agents WHERE id = $1',
    [created.id],
  );
  expect(still.rows[0]?.last_seen_at.toISOString()).toBe(frozen);

  const missing = await app.inject({
    method: 'POST',
    url: '/dashboard/agents/00000000-0000-4000-8000-000000000099/token',
    headers: desk(),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'not found' });
  const badId = await app.inject({
    method: 'POST',
    url: '/dashboard/agents/not-a-uuid/token/revoke',
    headers: desk(),
  });
  expect(badId.statusCode).toBe(400);

  const restored = await app.inject({
    method: 'POST',
    url: `/dashboard/agents/${created.id}/token`,
    headers: desk(),
  });
  const again = restored.json() as RegisteredAgent;
  expect(restored.statusCode).toBe(201);
  const back = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: { authorization: `Bearer ${again.token}` },
  });
  expect(back.statusCode).toBe(200);
  const flags = await admin.query<{ token_revoked: boolean }>(
    'SELECT token_revoked FROM agents WHERE id = $1',
    [created.id],
  );
  expect(flags.rows[0]?.token_revoked).toBe(false);
  expect(again).toMatchObject({ id: created.id, name: 'alpha' });
});

test('message history is oldest-first, paged, and marks broadcasts', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const sent = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: { authorization: `Bearer ${alpha.token}` },
    payload: { to: 'beta', body: 'direct' },
  });
  expect(sent.statusCode).toBe(201);
  const broadcast = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: { authorization: `Bearer ${alpha.token}` },
    payload: { to: '*', body: 'all' },
  });
  expect(broadcast.statusCode).toBe(201);

  const history = await app.inject({
    method: 'GET',
    url: '/dashboard/messages',
    headers: desk(),
  });
  expect(history.statusCode).toBe(200);
  const page = history.json() as HistoryPage;
  expect(page.messages.map((message) => message.body)).toEqual([
    'direct',
    'all',
  ]);
  expect(page.messages[0]).toMatchObject({ from: 'alpha', to: 'beta' });
  expect(page.messages[1]).toMatchObject({ from: 'alpha', to: '*' });
  expect(page.next).toBeNull();
  expect(history.body).not.toContain(alpha.token);

  await admin.query(
    `INSERT INTO messages (from_agent, to_agent, body, created_at)
     SELECT $1::uuid,
            $2::uuid,
            'm' || g::text,
            timestamp '2024-01-01' + (g::text || ' milliseconds')::interval
     FROM generate_series(1, 51) AS g`,
    [alpha.id, beta.id],
  );
  const first = await app.inject({
    method: 'GET',
    url: '/dashboard/messages?limit=50',
    headers: desk(),
  });
  const firstPage = first.json() as HistoryPage;
  expect(firstPage.messages).toHaveLength(50);
  expect(firstPage.messages[0]?.body).toBe('m1');
  expect(firstPage.next).toBe(
    `${firstPage.messages[49]?.createdAt}|${firstPage.messages[49]?.id}`,
  );
  const cursor = firstPage.next;
  if (cursor === null) {
    throw new Error('expected a cursor');
  }
  const second = await app.inject({
    method: 'GET',
    url: `/dashboard/messages?${new URLSearchParams({ after: cursor }).toString()}`,
    headers: desk(),
  });
  const secondPage = second.json() as HistoryPage;
  expect(secondPage.messages.map((message) => message.body)).toContain('m51');
  expect(secondPage.messages.map((message) => message.body)).toContain(
    'direct',
  );

  const badCursor = await app.inject({
    method: 'GET',
    url: '/dashboard/messages?after=nope',
    headers: desk(),
  });
  expect(badCursor.statusCode).toBe(400);
  const badLimit = await app.inject({
    method: 'GET',
    url: '/dashboard/messages?limit=201',
    headers: desk(),
  });
  expect(badLimit.statusCode).toBe(400);
});

test('an agent inbox is readable without marking it read or updating last_seen', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const sent = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: { authorization: `Bearer ${alpha.token}` },
    payload: { to: 'beta', body: '<script>alert(1)</script>' },
  });
  expect(sent.statusCode).toBe(201);
  const messageId = (sent.json() as { id: string }).id;
  await admin.query(
    `UPDATE agents SET last_seen_at = '2020-01-01T00:00:00Z' WHERE id = $1`,
    [beta.id],
  );

  const inbox = await app.inject({
    method: 'GET',
    url: `/dashboard/agents/${beta.id}/inbox`,
    headers: desk(),
  });
  expect(inbox.statusCode).toBe(200);
  const page = inbox.json() as InboxPage;
  expect(page.messages).toEqual([
    expect.objectContaining({
      id: messageId,
      from: 'alpha',
      to: 'beta',
      body: '<script>alert(1)</script>',
      readAt: null,
    }),
  ]);
  const receipt = await admin.query<{ read_at: Date | null }>(
    `SELECT read_at FROM message_receipts
     WHERE message_id = $1 AND agent_id = $2`,
    [messageId, beta.id],
  );
  expect(receipt.rows[0]?.read_at).toBeNull();
  const seen = await admin.query<{ last_seen_at: Date }>(
    'SELECT last_seen_at FROM agents WHERE id = $1',
    [beta.id],
  );
  expect(seen.rows[0]?.last_seen_at.toISOString()).toBe(
    '2020-01-01T00:00:00.000Z',
  );

  const alphaInbox = await app.inject({
    method: 'GET',
    url: `/dashboard/agents/${alpha.id}/inbox`,
    headers: desk(),
  });
  expect(alphaInbox.json()).toEqual({ messages: [], next: null });

  const missing = await app.inject({
    method: 'GET',
    url: '/dashboard/agents/00000000-0000-4000-8000-000000000099/inbox',
    headers: desk(),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'not found' });

  const badCursor = await app.inject({
    method: 'GET',
    url: `/dashboard/agents/${beta.id}/inbox?after=nope`,
    headers: desk(),
  });
  expect(badCursor.statusCode).toBe(400);
  expect(badCursor.json()).toEqual({ error: 'invalid request' });

  expect(missing.body).not.toContain(alpha.token);
});

function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('encoded, mixed-case, and double-slash dashboard paths do not accept an agent token', async () => {
  const alpha = await register('alpha');
  const exposed = buildApp(databaseUrl, { dashboardSecret: SECRET });
  await exposed.ready();
  await exposed.migrationsReady;
  const address = await exposed.listen({ host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  try {
    const paths = [
      '/%64ashboard/agents',
      '/Dashboard/agents',
      '//dashboard/agents',
      '/dashboard/agents',
    ];
    for (const path of paths) {
      const response = await rawGet(port, path, {
        authorization: `Bearer ${alpha.token}`,
      });
      expect(response.status, path).not.toBe(200);
      expect(response.body, path).not.toContain(alpha.name);
      expect(response.body, path).not.toContain(alpha.token);
    }
    const opened = await rawGet(port, '/dashboard/agents', desk());
    expect(opened.status).toBe(200);
    expect(opened.body).toContain(alpha.name);
    expect(opened.body).not.toContain(alpha.token);
  } finally {
    await exposed.close();
  }
});

test('a new desk session replaces the previous one and a notice is taken once', async () => {
  const first = await app.inject({
    method: 'POST',
    url: '/dashboard/sessions',
    headers: desk(),
  });
  expect(first.statusCode).toBe(201);
  const opened = first.json() as { id: string; csrfToken: string };
  expect(opened.id).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  expect(opened.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  expect(opened.csrfToken).not.toBe(opened.id);

  const read = await app.inject({
    method: 'GET',
    url: `/dashboard/sessions/${opened.id}`,
    headers: desk(),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toEqual({ csrfToken: opened.csrfToken });

  const wrongId = await app.inject({
    method: 'GET',
    url: '/dashboard/sessions/not-a-valid-id',
    headers: desk('wrong-desk-key'),
  });
  expect(wrongId.statusCode).toBe(401);

  const second = await app.inject({
    method: 'POST',
    url: '/dashboard/sessions',
    headers: desk(),
  });
  expect(second.statusCode).toBe(201);
  const next = second.json() as { id: string; csrfToken: string };
  const stale = await app.inject({
    method: 'GET',
    url: `/dashboard/sessions/${opened.id}`,
    headers: desk(),
  });
  expect(stale.statusCode).toBe(404);

  const notice = await app.inject({
    method: 'POST',
    url: `/dashboard/sessions/${next.id}/notices`,
    headers: desk(),
    payload: {
      type: 'issued',
      id: 'agent',
      name: 'alpha',
      token: 'shown-once',
    },
  });
  expect(notice.statusCode).toBe(201);
  const noticeId = (notice.json() as { id: string }).id;

  const taken = await app.inject({
    method: 'POST',
    url: `/dashboard/sessions/${next.id}/notices/${noticeId}/take`,
    headers: desk(),
  });
  expect(taken.statusCode).toBe(200);
  expect(taken.json()).toEqual({
    type: 'issued',
    id: 'agent',
    name: 'alpha',
    token: 'shown-once',
  });
  const again = await app.inject({
    method: 'POST',
    url: `/dashboard/sessions/${next.id}/notices/${noticeId}/take`,
    headers: desk(),
  });
  expect(again.statusCode).toBe(404);

  const removed = await app.inject({
    method: 'DELETE',
    url: `/dashboard/sessions/${next.id}`,
    headers: desk(),
  });
  expect(removed.statusCode).toBe(204);
  const gone = await app.inject({
    method: 'GET',
    url: `/dashboard/sessions/${next.id}`,
    headers: desk(),
  });
  expect(gone.statusCode).toBe(404);
});

test('logs redact the dashboard secret and issued tokens', async () => {
  const lines: string[] = [];
  const logged = buildApp(databaseUrl, {
    dashboardSecret: SECRET,
    logStream: {
      write(message: string) {
        lines.push(message);
      },
    },
  });
  try {
    await logged.migrationsReady;
    const created = await logged.inject({
      method: 'POST',
      url: '/dashboard/agents',
      headers: desk(),
      payload: { name: 'logger' },
    });
    expect(created.statusCode).toBe(201);
    const token = (created.json() as RegisteredAgent).token;
    const issued = await logged.inject({
      method: 'POST',
      url: `/dashboard/agents/${(created.json() as RegisteredAgent).id}/token`,
      headers: desk(),
    });
    expect(issued.statusCode).toBe(201);
    const next = (issued.json() as RegisteredAgent).token;
    const wrong = await logged.inject({
      method: 'GET',
      url: '/dashboard/agents',
      headers: desk('wrong-desk-key'),
    });
    expect(wrong.statusCode).toBe(401);
    const output = lines.join('\n');
    expect(output).toContain('[Redacted]');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('wrong-desk-key');
    expect(output).not.toContain(token);
    expect(output).not.toContain(next);
  } finally {
    await logged.close();
  }
});

test('a database outage is 503 for a valid desk key and 401 without waiting for a wrong one', async () => {
  const logs: string[] = [];
  const down = buildApp(
    'postgres://switchboard_user:s3cret-pass@127.0.0.1:1/unreachable_test',
    {
      dashboardSecret: SECRET,
      logStream: {
        write(message: string) {
          logs.push(message);
        },
      },
    },
  );
  try {
    const started = Date.now();
    const rejected = await down.inject({
      method: 'GET',
      url: '/dashboard/agents',
      headers: desk('wrong-desk-key'),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain('s3cret-pass');
    expect(rejected.body).not.toContain('wrong-desk-key');

    const response = await down.inject({
      method: 'GET',
      url: '/dashboard/messages',
      headers: desk(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"error":"database_unavailable"}');
    expect(response.body).not.toMatch(
      /ECONNREFUSED|switchboard_user|s3cret-pass|unreachable_test|desk-secret/,
    );
    expect(logs.join('\n')).not.toContain(SECRET);
  } finally {
    await down.close();
  }
});

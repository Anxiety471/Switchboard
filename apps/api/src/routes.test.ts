import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from './app.js';
import type {
  AgentSummary,
  InboxMessage,
  ReadReceipt,
  RegisteredAgent,
  SentMessage,
} from '@switchboard/shared';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const app = buildApp(databaseUrl);
const admin = new Client({ connectionString: databaseUrl });

beforeAll(async () => {
  await admin.connect();
  await app.ready();
});

beforeEach(async () => {
  await admin.query('TRUNCATE agents CASCADE');
});

afterAll(async () => {
  await admin.end();
  await app.close();
});

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function register(name: string): Promise<RegisteredAgent> {
  const response = await app.inject({
    method: 'POST',
    url: '/agents',
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function send(
  token: string,
  payload: { to: string; body: string },
): Promise<SentMessage> {
  const response = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(token),
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function inbox(
  token: string,
  unread?: boolean,
): Promise<{ messages: InboxMessage[] }> {
  const url =
    unread === undefined ? '/inbox' : `/inbox?unread=${String(unread)}`;
  const response = await app.inject({
    method: 'GET',
    url,
    headers: bearer(token),
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function markRead(token: string, ids: string[]): Promise<ReadReceipt> {
  const response = await app.inject({
    method: 'POST',
    url: '/inbox/read',
    headers: bearer(token),
    payload: { ids },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

test('migration creates agents, messages, and per-recipient receipts', async () => {
  const tables = await admin.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name`,
  );
  expect(tables.rows.map((row) => row.table_name)).toEqual([
    'agents',
    'message_receipts',
    'messages',
    'schema_migrations',
  ]);

  const columns = await admin.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('agents', 'messages')
     ORDER BY table_name, column_name`,
  );
  expect(columns.rows).toEqual([
    { table_name: 'agents', column_name: 'created_at' },
    { table_name: 'agents', column_name: 'id' },
    { table_name: 'agents', column_name: 'last_seen_at' },
    { table_name: 'agents', column_name: 'name' },
    { table_name: 'agents', column_name: 'token_hash' },
    { table_name: 'messages', column_name: 'body' },
    { table_name: 'messages', column_name: 'created_at' },
    { table_name: 'messages', column_name: 'from_agent' },
    { table_name: 'messages', column_name: 'id' },
    { table_name: 'messages', column_name: 'read_at' },
    { table_name: 'messages', column_name: 'to_agent' },
  ]);
});

test('POST /agents returns a token once and stores only its hash', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/agents',
    payload: { name: 'alpha' },
  });
  expect(response.statusCode).toBe(201);
  const created = response.json() as RegisteredAgent;
  expect(created.name).toBe('alpha');
  expect(created.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const stored = await admin.query<{
    token_hash: Buffer;
    last_seen_at: Date | null;
  }>('SELECT token_hash, last_seen_at FROM agents WHERE name = $1', ['alpha']);
  const row = stored.rows[0];
  expect(row).toBeDefined();
  const hash = createHash('sha256').update(created.token).digest();
  expect(Buffer.from(row?.token_hash ?? Buffer.alloc(0)).equals(hash)).toBe(
    true,
  );
  expect(row?.last_seen_at).toBeNull();

  const leaked = await admin.query(
    `SELECT count(*)::int AS matches
     FROM agents
     WHERE position($1 in name) > 0
        OR position($1 in encode(token_hash, 'hex')) > 0
        OR position($1 in encode(token_hash, 'base64')) > 0`,
    [created.token],
  );
  expect(leaked.rows[0]?.matches).toBe(0);
});

test('duplicate agent names return 409 and do not issue a token', async () => {
  const first = await register('alpha');
  const duplicate = await app.inject({
    method: 'POST',
    url: '/agents',
    payload: { name: 'alpha' },
  });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({ error: 'name already registered' });
  expect(duplicate.body).not.toContain(first.token);

  const [left, right] = await Promise.all([
    app.inject({ method: 'POST', url: '/agents', payload: { name: 'race' } }),
    app.inject({ method: 'POST', url: '/agents', payload: { name: 'race' } }),
  ]);
  expect([left.statusCode, right.statusCode].sort()).toEqual([201, 409]);
  const count = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM agents WHERE name = $1',
    ['race'],
  );
  expect(count.rows[0]?.count).toBe(1);
  const loser = left.statusCode === 409 ? left : right;
  expect(loser.body).not.toContain('token');
});

test('POST /agents rejects invalid names', async () => {
  const names = [
    '',
    '*',
    'has space',
    '-leading',
    'a'.repeat(65),
    'bad/name',
    'nül',
  ];
  for (const name of names) {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid request' });
  }

  const extra = await app.inject({
    method: 'POST',
    url: '/agents',
    payload: { name: 'alpha', token: 'nope' },
  });
  expect(extra.statusCode).toBe(400);
  expect(extra.body).not.toContain('nope');

  const valid = await register(`a${'b'.repeat(63)}`);
  expect(valid.name).toHaveLength(64);
});

test('missing token is unauthorized on protected routes', async () => {
  const health = await app.inject({ method: 'GET', url: '/health' });
  expect(health.statusCode).toBe(200);

  const cases = [
    { method: 'GET' as const, url: '/agents' },
    {
      method: 'POST' as const,
      url: '/messages',
      payload: { to: 'alpha', body: 'hi' },
    },
    { method: 'GET' as const, url: '/inbox' },
    { method: 'GET' as const, url: '/inbox?unread=true' },
    { method: 'POST' as const, url: '/inbox/read', payload: { ids: [] } },
    { method: 'GET' as const, url: '/missing' },
  ];
  for (const route of cases) {
    const response = await app.inject(route);
    expect(response.statusCode, route.url).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  }

  const malformed = ['Token abc', 'Bearer', 'Bearer ', 'bearer not base64!'];
  for (const authorization of malformed) {
    const response = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(authorization);
  }
});

test('wrong token is unauthorized and is not echoed', async () => {
  const alpha = await register('alpha');
  const wrong = 'not-a-real-token';
  const routes = [
    { method: 'GET' as const, url: '/agents' },
    { method: 'GET' as const, url: '/inbox?unread=true' },
    {
      method: 'POST' as const,
      url: '/messages',
      payload: { to: 'alpha', body: 'hi' },
    },
    {
      method: 'POST' as const,
      url: '/inbox/read',
      payload: { ids: ['00000000-0000-4000-8000-000000000001'] },
    },
  ];
  for (const route of routes) {
    const response = await app.inject({
      ...route,
      headers: bearer(wrong),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.body).not.toContain(wrong);
    expect(response.body).not.toContain(alpha.token);
  }
});

test('GET /agents reports online status from the last 60 seconds', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const before = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: bearer(alpha.token),
  });
  expect(before.statusCode).toBe(200);
  const listed = before.json() as { agents: AgentSummary[] };
  expect(listed.agents.map((agent) => agent.name)).toEqual(['alpha', 'beta']);
  expect(listed.agents[0]).toMatchObject({ name: 'alpha', online: true });
  expect(listed.agents[1]).toMatchObject({
    id: beta.id,
    name: 'beta',
    online: false,
    lastSeenAt: null,
  });
  expect(JSON.stringify(listed)).not.toContain(alpha.token);
  expect(JSON.stringify(listed)).not.toContain('token');

  await admin.query(
    `UPDATE agents
     SET last_seen_at = clock_timestamp() - interval '30 seconds'
     WHERE name = 'beta'`,
  );
  const recent = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: bearer(alpha.token),
  });
  const recentBeta = (recent.json() as { agents: AgentSummary[] }).agents.find(
    (agent) => agent.name === 'beta',
  );
  expect(recentBeta?.online).toBe(true);

  await admin.query(
    `UPDATE agents
     SET last_seen_at = clock_timestamp() - interval '61 seconds'
     WHERE name = 'beta'`,
  );
  const stale = await app.inject({
    method: 'GET',
    url: '/agents',
    headers: bearer(alpha.token),
  });
  const staleBeta = (stale.json() as { agents: AgentSummary[] }).agents.find(
    (agent) => agent.name === 'beta',
  );
  expect(staleBeta?.online).toBe(false);
  expect(staleBeta?.lastSeenAt).toEqual(expect.any(String));

  await admin.query(
    `UPDATE agents SET last_seen_at = '2000-01-01T00:00:00Z' WHERE name = 'alpha'`,
  );
  await app.inject({
    method: 'POST',
    url: '/inbox/read',
    headers: bearer(alpha.token),
    payload: { ids: [] },
  });
  const seen = await admin.query<{ last_seen_at: Date }>(
    'SELECT last_seen_at FROM agents WHERE name = $1',
    ['alpha'],
  );
  expect(seen.rows[0]?.last_seen_at.getTime()).toBeGreaterThan(
    Date.parse('2020-01-01T00:00:00Z'),
  );
});

test('POST /messages validates the body and recipient', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');

  const unknown = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(alpha.token),
    payload: { to: 'nobody', body: 'hello' },
  });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toEqual({ error: 'recipient not found' });

  const self = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(alpha.token),
    payload: { to: 'alpha', body: 'hello' },
  });
  expect(self.statusCode).toBe(400);

  const empty = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(alpha.token),
    payload: { to: 'beta', body: '' },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toEqual({ error: 'invalid request' });

  const oversized = 'x'.repeat(8193);
  const tooBig = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(alpha.token),
    payload: { to: 'beta', body: oversized },
  });
  expect(tooBig.statusCode).toBe(400);
  expect(tooBig.body).not.toContain(oversized.slice(0, 64));

  const wide = 'é'.repeat(4097);
  expect(Buffer.byteLength(wide, 'utf8')).toBeGreaterThan(8192);
  const tooWide = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: bearer(alpha.token),
    payload: { to: 'beta', body: wide },
  });
  expect(tooWide.statusCode).toBe(400);

  const exact = await send(alpha.token, { to: 'beta', body: 'x'.repeat(8192) });
  expect(exact.id).toMatch(/-/);
  const exactWide = await send(alpha.token, {
    to: 'beta',
    body: 'é'.repeat(4096),
  });
  expect(exactWide.id).not.toBe(exact.id);

  const hostile = await send(alpha.token, {
    to: 'beta',
    body: "'); DROP TABLE agents;--",
  });
  const surviving = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM agents',
  );
  expect(surviving.rows[0]?.count).toBe(2);
  const stored = await inbox(beta.token, true);
  expect(stored.messages.map((message) => message.id)).toContain(hostile.id);

  expect(alpha.id).not.toBe(beta.id);
});

test('direct messages are oldest-first and visible only to the recipient', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const gamma = await register('gamma');
  const newer = await send(beta.token, { to: 'alpha', body: 'second' });
  const older = await send(gamma.token, { to: 'alpha', body: 'first' });
  await admin.query('UPDATE messages SET created_at = $2 WHERE id = $1', [
    newer.id,
    '2024-02-01T00:00:00Z',
  ]);
  await admin.query('UPDATE messages SET created_at = $2 WHERE id = $1', [
    older.id,
    '2024-01-01T00:00:00Z',
  ]);

  const all = await inbox(alpha.token, false);
  expect(all.messages.map((message) => message.body)).toEqual([
    'first',
    'second',
  ]);
  expect(all.messages[0]).toMatchObject({
    id: older.id,
    from: 'gamma',
    to: 'alpha',
    readAt: null,
  });
  expect(await inbox(beta.token)).toEqual({ messages: [] });
  expect((await inbox(gamma.token)).messages).toEqual([]);

  await markRead(alpha.token, [older.id]);
  expect(
    (await inbox(alpha.token, true)).messages.map((message) => message.id),
  ).toEqual([newer.id]);
  expect((await inbox(alpha.token, false)).messages).toHaveLength(2);
  const direct = await admin.query<{ read_at: Date | null }>(
    'SELECT read_at FROM messages WHERE id = $1',
    [older.id],
  );
  expect(direct.rows[0]?.read_at).not.toBeNull();
  const untouched = await admin.query<{ read_at: Date | null }>(
    'SELECT read_at FROM messages WHERE id = $1',
    [newer.id],
  );
  expect(untouched.rows[0]?.read_at).toBeNull();
});

test('agent B cannot read or mark agent A messages', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const secret = await send(beta.token, {
    to: 'alpha',
    body: 'only-for-alpha',
  });

  const betaInbox = await inbox(beta.token, true);
  expect(betaInbox.messages).toEqual([]);
  expect(JSON.stringify(betaInbox)).not.toContain('only-for-alpha');
  expect(JSON.stringify(betaInbox)).not.toContain(secret.id);

  const alphaInbox = await inbox(alpha.token, true);
  expect(alphaInbox.messages.map((message) => message.id)).toEqual([secret.id]);

  const denied = await markRead(beta.token, [secret.id]);
  expect(denied.read).toEqual([]);
  expect(
    (await inbox(alpha.token, true)).messages.map((message) => message.id),
  ).toEqual([secret.id]);

  const receipt = await admin.query<{ read_at: Date | null }>(
    `SELECT read_at
     FROM message_receipts
     WHERE message_id = $1 AND agent_id = $2`,
    [secret.id, alpha.id],
  );
  expect(receipt.rows[0]?.read_at).toBeNull();
  const message = await admin.query<{ read_at: Date | null }>(
    'SELECT read_at FROM messages WHERE id = $1',
    [secret.id],
  );
  expect(message.rows[0]?.read_at).toBeNull();

  const mixed = await app.inject({
    method: 'POST',
    url: '/inbox/read',
    headers: bearer(alpha.token),
    payload: {
      ids: [secret.id, '00000000-0000-4000-8000-000000000099'],
    },
  });
  expect(mixed.statusCode).toBe(200);
  expect(mixed.json()).toEqual({ read: [secret.id] });
  expect(mixed.body).not.toContain(alpha.token);

  const otherQuery = await app.inject({
    method: 'GET',
    url: `/inbox?agent=${alpha.id}`,
    headers: bearer(beta.token),
  });
  expect(otherQuery.statusCode).toBe(400);
});

test('broadcast fan-out keeps read state per recipient', async () => {
  const alpha = await register('alpha');
  const beta = await register('beta');
  const gamma = await register('gamma');
  const sent = await send(alpha.token, { to: '*', body: 'hello all' });

  expect(await inbox(alpha.token, true)).toEqual({ messages: [] });
  const betaUnread = await inbox(beta.token, true);
  const gammaUnread = await inbox(gamma.token, true);
  expect(betaUnread.messages.map((message) => message.id)).toEqual([sent.id]);
  expect(gammaUnread.messages.map((message) => message.id)).toEqual([sent.id]);
  expect(betaUnread.messages[0]).toMatchObject({
    from: 'alpha',
    to: '*',
    body: 'hello all',
    readAt: null,
  });

  expect(await markRead(beta.token, [sent.id])).toEqual({ read: [sent.id] });
  expect(await inbox(beta.token, true)).toEqual({ messages: [] });
  expect(
    (await inbox(gamma.token, true)).messages.map((message) => message.id),
  ).toEqual([sent.id]);
  expect(await markRead(alpha.token, [sent.id])).toEqual({ read: [] });

  const reads = await admin.query<{ name: string; read: boolean }>(
    `SELECT agents.name, message_receipts.read_at IS NOT NULL AS read
     FROM message_receipts
     JOIN agents ON agents.id = message_receipts.agent_id
     WHERE message_receipts.message_id = $1
     ORDER BY agents.name`,
    [sent.id],
  );
  expect(reads.rows).toEqual([
    { name: 'beta', read: true },
    { name: 'gamma', read: false },
  ]);
  const stored = await admin.query<{
    to_agent: string | null;
    read_at: Date | null;
  }>('SELECT to_agent, read_at FROM messages WHERE id = $1', [sent.id]);
  expect(stored.rows[0]).toEqual({ to_agent: null, read_at: null });

  const delta = await register('delta');
  expect(await inbox(delta.token, true)).toEqual({ messages: [] });

  const alone = await register('solo');
  const empty = await send(alone.token, { to: '*', body: 'nobody else' });
  expect(empty.id).toMatch(/-/);
  expect(await inbox(alone.token)).toEqual({ messages: [] });
});

test('logs redact authorization and never include tokens', async () => {
  const lines: string[] = [];
  const logged = buildApp(databaseUrl, {
    logStream: {
      write(message: string) {
        lines.push(message);
      },
    },
  });
  try {
    const created = await logged.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'logger' },
    });
    const token = (created.json() as RegisteredAgent).token;
    const authed = await logged.inject({
      method: 'GET',
      url: '/agents',
      headers: bearer(token),
    });
    expect(authed.statusCode).toBe(200);
    const wrong = await logged.inject({
      method: 'GET',
      url: '/inbox',
      headers: bearer('wrong-token-value'),
    });
    expect(wrong.statusCode).toBe(401);
    const output = lines.join('\n');
    expect(output).toContain('[Redacted]');
    expect(output).not.toContain(token);
    expect(output).not.toContain('wrong-token-value');
  } finally {
    await logged.close();
  }
});

test('request bodies have length limits', async () => {
  const alpha = await register('alpha');
  const huge = 'y'.repeat(40_000);
  const limited = await app.inject({
    method: 'POST',
    url: '/messages',
    headers: {
      ...bearer(alpha.token),
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ to: 'alpha', body: huge }),
  });
  expect(limited.statusCode).toBe(413);
  expect(limited.body).not.toContain(huge.slice(0, 32));

  const ids = Array.from(
    { length: 101 },
    () => '00000000-0000-4000-8000-000000000001',
  );
  const tooMany = await app.inject({
    method: 'POST',
    url: '/inbox/read',
    headers: bearer(alpha.token),
    payload: { ids },
  });
  expect(tooMany.statusCode).toBe(400);
  expect(tooMany.json()).toEqual({ error: 'invalid request' });

  const badUnread = await app.inject({
    method: 'GET',
    url: '/inbox?unread=1',
    headers: bearer(alpha.token),
  });
  expect(badUnread.statusCode).toBe(400);
});

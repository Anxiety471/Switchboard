import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { buildApp } from './app.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

const SECRET = 'integration-desk-secret';
const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const app = buildApp(databaseUrl, { dashboardSecret: SECRET });
const admin = new Client({ connectionString: databaseUrl });

let baseUrl = '';

beforeAll(async () => {
  await admin.connect();
  await app.ready();
  await app.migrationsReady;
  baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});

beforeEach(async () => {
  await admin.query('TRUNCATE agents CASCADE');
});

afterAll(async () => {
  await admin.end();
  await app.close();
});

function desk(secret = SECRET): Record<string, string> {
  return { 'x-dashboard-secret': secret, accept: 'application/json' };
}

async function register(name: string): Promise<Response> {
  return fetch(`${baseUrl}/dashboard/agents`, {
    method: 'POST',
    headers: { ...desk(), 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

test('dashboard routes register, read, and rotate tokens over HTTP', async () => {
  const alphaResponse = await register('alpha');
  const betaResponse = await register('beta');
  expect(alphaResponse.status).toBe(201);
  expect(betaResponse.status).toBe(201);
  const alpha = (await alphaResponse.json()) as {
    id: string;
    name: string;
    token: string;
  };
  const beta = (await betaResponse.json()) as {
    id: string;
    name: string;
    token: string;
  };
  expect(alpha.token).not.toBe(beta.token);

  const duplicate = await register('Alpha');
  expect(duplicate.status).toBe(409);

  const sent = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alpha.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to: 'beta', body: 'from the bench' }),
  });
  expect(sent.status).toBe(201);

  const agents = await fetch(`${baseUrl}/dashboard/agents`, {
    headers: desk(),
  });
  const history = await fetch(`${baseUrl}/dashboard/messages`, {
    headers: desk(),
  });
  const inbox = await fetch(`${baseUrl}/dashboard/agents/${beta.id}/inbox`, {
    headers: desk(),
  });
  expect(agents.status).toBe(200);
  expect(history.status).toBe(200);
  expect(inbox.status).toBe(200);
  const ledger = {
    agents: (await agents.json()) as { agents: { name: string }[] },
    history: (await history.json()) as { messages: { body: string }[] },
    inbox: (await inbox.json()) as {
      messages: { from: string; to: string; body: string; readAt: null }[];
    },
  };
  expect(ledger.agents.agents.map((agent) => agent.name)).toEqual([
    'alpha',
    'beta',
  ]);
  expect(ledger.history.messages.map((message) => message.body)).toEqual([
    'from the bench',
  ]);
  expect(ledger.inbox.messages).toEqual([
    expect.objectContaining({
      from: 'alpha',
      to: 'beta',
      body: 'from the bench',
      readAt: null,
    }),
  ]);
  const serialized = JSON.stringify(ledger);
  expect(serialized).not.toContain(alpha.token);
  expect(serialized).not.toContain(SECRET);

  const receipt = await admin.query<{ read_at: Date | null }>(
    `SELECT read_at
     FROM message_receipts
     WHERE agent_id = $1`,
    [beta.id],
  );
  expect(receipt.rows[0]?.read_at).toBeNull();

  const revoked = await fetch(
    `${baseUrl}/dashboard/agents/${alpha.id}/token/revoke`,
    { method: 'POST', headers: desk() },
  );
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({
    id: alpha.id,
    name: 'alpha',
    tokenRevoked: true,
  });
  const locked = await fetch(`${baseUrl}/agents`, {
    headers: { authorization: `Bearer ${alpha.token}` },
  });
  expect(locked.status).toBe(401);

  const issued = await fetch(`${baseUrl}/dashboard/agents/${alpha.id}/token`, {
    method: 'POST',
    headers: desk(),
  });
  expect(issued.status).toBe(201);
  const replacement = (await issued.json()) as { token: string };
  const unlocked = await fetch(`${baseUrl}/agents`, {
    headers: { authorization: `Bearer ${replacement.token}` },
  });
  expect(unlocked.status).toBe(200);
  expect(replacement.token).not.toBe(alpha.token);

  const rejected = await fetch(`${baseUrl}/dashboard/agents`, {
    headers: desk('wrong-desk-key'),
  });
  expect(rejected.status).toBe(401);
  const rejectedBody = await rejected.text();
  expect(rejectedBody).not.toContain('wrong-desk-key');
  expect(rejectedBody).not.toContain(SECRET);
});

test('a closed database returns 503 and a closed port is unreachable', async () => {
  const down = buildApp(
    'postgres://switchboard_user:s3cret-pass@127.0.0.1:1/unreachable_test',
    { dashboardSecret: SECRET },
  );
  try {
    const address = await down.listen({ host: '127.0.0.1', port: 0 });
    const result = await fetch(`${address}/dashboard/agents`, {
      headers: desk(),
    });
    expect(result.status).toBe(503);
    const body = await result.text();
    expect(body).toContain('database_unavailable');
    expect(body).not.toContain('s3cret-pass');
    expect(body).not.toContain(SECRET);
  } finally {
    await down.close();
  }

  await expect(
    fetch('http://127.0.0.1:1/dashboard/agents', { headers: desk() }),
  ).rejects.toThrow();
});

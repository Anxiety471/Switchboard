import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { readDeskConfig } from '../../web/lib/config.js';
import {
  issueAgentToken,
  loadLedger,
  registerAgent,
  revokeAgentToken,
  type LedgerSelection,
} from '../../web/lib/ledger.js';
import { buildApp } from './app.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

const SECRET = 'integration-desk-secret';
const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const app = buildApp(databaseUrl, { dashboardSecret: SECRET });
const admin = new Client({ connectionString: databaseUrl });
const selection: LedgerSelection = {
  inboxId: undefined,
  historyAfter: undefined,
  inboxAfter: undefined,
};

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

function configFor(url: string, secret = SECRET) {
  const config = readDeskConfig({
    SWITCHBOARD_URL: url,
    DASHBOARD_SECRET: secret,
  });
  if (config === undefined) {
    throw new Error('expected a desk config');
  }
  return config;
}

test('the web client registers, reads, and rotates tokens through the API', async () => {
  const config = configFor(baseUrl);
  const alpha = await registerAgent(config, 'alpha');
  const beta = await registerAgent(config, 'beta');
  expect(alpha.ok).toBe(true);
  expect(beta.ok).toBe(true);
  if (!alpha.ok || !beta.ok) {
    throw new Error('expected both agents');
  }
  expect(alpha.value.token).not.toBe(beta.value.token);

  const duplicate = await registerAgent(config, 'Alpha');
  expect(duplicate).toEqual({ ok: false, failure: 'conflict' });

  const sent = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alpha.value.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to: 'beta', body: 'from the bench' }),
  });
  expect(sent.status).toBe(201);

  const ledger = await loadLedger(config, {
    inboxId: beta.value.id,
    historyAfter: undefined,
    inboxAfter: undefined,
  });
  expect(ledger.ok).toBe(true);
  if (!ledger.ok) {
    throw new Error('expected a ledger');
  }
  expect(ledger.value.agents.map((agent) => agent.name)).toEqual([
    'alpha',
    'beta',
  ]);
  expect(ledger.value.history.messages.map((message) => message.body)).toEqual([
    'from the bench',
  ]);
  expect(ledger.value.inbox?.messages).toEqual([
    expect.objectContaining({
      from: 'alpha',
      to: 'beta',
      body: 'from the bench',
      readAt: null,
    }),
  ]);
  expect(JSON.stringify(ledger.value)).not.toContain(alpha.value.token);
  expect(JSON.stringify(ledger.value)).not.toContain(SECRET);

  const receipt = await admin.query<{ read_at: Date | null }>(
    `SELECT read_at
     FROM message_receipts
     WHERE agent_id = $1`,
    [beta.value.id],
  );
  expect(receipt.rows[0]?.read_at).toBeNull();

  const revoked = await revokeAgentToken(config, alpha.value.id);
  expect(revoked).toEqual({
    ok: true,
    value: { id: alpha.value.id, name: 'alpha', tokenRevoked: true },
  });
  const locked = await fetch(`${baseUrl}/agents`, {
    headers: { authorization: `Bearer ${alpha.value.token}` },
  });
  expect(locked.status).toBe(401);

  const issued = await issueAgentToken(config, alpha.value.id);
  expect(issued.ok).toBe(true);
  if (!issued.ok) {
    throw new Error('expected a replacement token');
  }
  const unlocked = await fetch(`${baseUrl}/agents`, {
    headers: { authorization: `Bearer ${issued.value.token}` },
  });
  expect(unlocked.status).toBe(200);
  expect(issued.value.token).not.toBe(alpha.value.token);

  const rejected = await loadLedger(
    configFor(baseUrl, 'wrong-desk-key'),
    selection,
  );
  expect(rejected).toEqual({ ok: false, failure: 'unauthorized' });
  expect(JSON.stringify(rejected)).not.toContain('wrong-desk-key');
  expect(JSON.stringify(rejected)).not.toContain(SECRET);
});

test('the web client surfaces a database outage and an unreachable API', async () => {
  const down = buildApp(
    'postgres://switchboard_user:s3cret-pass@127.0.0.1:1/unreachable_test',
    { dashboardSecret: SECRET },
  );
  try {
    const address = await down.listen({ host: '127.0.0.1', port: 0 });
    const result = await loadLedger(configFor(address), selection);
    expect(result).toEqual({ ok: false, failure: 'database_unavailable' });
    expect(JSON.stringify(result)).not.toContain('s3cret-pass');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  } finally {
    await down.close();
  }

  const unreachable = await loadLedger(
    { url: 'http://127.0.0.1:1', secret: SECRET },
    selection,
  );
  expect(unreachable).toEqual({ ok: false, failure: 'unreachable' });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool, type PoolClient } from 'pg';
import { expect, test } from 'vitest';
import { buildApp } from './app.js';
import { migrate } from './migrate.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';
import { generateToken, hashToken } from './token.js';

const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);

function migrationPool(): Pool {
  return new Pool({
    connectionString: databaseUrl,
    statement_timeout: 2000,
    query_timeout: 2500,
    max: 1,
  });
}

async function expectRestoredTimeout(pool: Pool): Promise<void> {
  expect(pool.totalCount).toBe(1);
  expect(pool.idleCount).toBe(1);
  const client = await pool.connect();
  try {
    const timeout = await client.query<{ statement_timeout: string }>(
      'SHOW statement_timeout',
    );
    expect(timeout.rows[0]?.statement_timeout).toBe('2s');
    const timed = client as PoolClient & {
      connectionParameters: { query_timeout?: number | false };
    };
    expect(timed.connectionParameters.query_timeout).toBe(2500);
  } finally {
    client.release();
  }
}

test('a failed migration restores the pooled client timeout', async () => {
  const pool = migrationPool();
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-migrate-'));
  await writeFile(
    join(directory, `900_fail_${Date.now()}.sql`),
    'SELECT 1 / 0',
  );
  try {
    await expect(migrate(pool, directory)).rejects.toThrow(/division by zero/);
    await expectRestoredTimeout(pool);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a slow migration statement is not cancelled', async () => {
  const pool = migrationPool();
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-migrate-'));
  const version = `900_slow_${Date.now()}.sql`;
  await writeFile(
    join(directory, version),
    "SELECT pg_sleep(3) WHERE current_setting('statement_timeout') = '0'",
  );
  const started = Date.now();
  try {
    await migrate(pool, directory);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    await expectRestoredTimeout(pool);
  } finally {
    await pool
      .query('DELETE FROM schema_migrations WHERE version = $1', [version])
      .catch(() => undefined);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a timed-out migration destroys the client instead of resetting', async () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    statement_timeout: 2000,
    query_timeout: 2500,
    max: 1,
  });
  pool.on('error', () => undefined);
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-migrate-'));
  const version = `900_timeout_${Date.now()}.sql`;
  await writeFile(join(directory, version), 'SELECT pg_sleep(30)');
  const timeoutMs = 1000;
  const admin = new Client({
    connectionString: databaseUrl,
    statement_timeout: 2000,
  });
  admin.on('error', () => undefined);
  await admin.connect();
  const started = Date.now();
  try {
    await expect(migrate(pool, directory, timeoutMs)).rejects.toThrow(
      /Query read timeout/,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsed).toBeLessThan(timeoutMs * 2);
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
  } finally {
    const leftover = await admin
      .query<{ pid: number }>(
        `SELECT pid
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND query LIKE '%pg_sleep(30)%'`,
      )
      .catch(() => undefined);
    for (const row of leftover?.rows ?? []) {
      await admin
        .query('SELECT pg_terminate_backend($1)', [row.pid])
        .catch(() => undefined);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const still = await admin
        .query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
             AND datname = current_database()
             AND query LIKE '%pg_sleep(30)%'`,
        )
        .catch(() => undefined);
      if ((still?.rowCount ?? 0) === 0) {
        break;
      }
      await delay(50);
    }
    await admin.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test('a stuck migration backend is cancelled, the lock is freed, and the next attempt succeeds', async () => {
  const pool = new Pool({
    connectionString: databaseUrl,
    statement_timeout: 2000,
    query_timeout: 2500,
    max: 1,
  });
  pool.on('error', () => undefined);
  const directory = await mkdtemp(join(tmpdir(), 'switchboard-migrate-'));
  const version = `900_stuck_${Date.now()}.sql`;
  await writeFile(join(directory, version), 'SELECT pg_sleep(30)');
  const nextDirectory = await mkdtemp(join(tmpdir(), 'switchboard-migrate-'));
  const nextVersion = `900_next_${Date.now()}.sql`;
  await writeFile(join(nextDirectory, nextVersion), 'SELECT 1');
  const admin = new Client({
    connectionString: databaseUrl,
    statement_timeout: 2000,
  });
  admin.on('error', () => undefined);
  await admin.connect();
  const timeoutMs = 3000;
  const pending = migrate(pool, directory, timeoutMs);
  let stuckPid: number | undefined;
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = await admin.query<{ pid: number }>(
        `SELECT pid
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND query LIKE '%pg_sleep(30)%'`,
      );
      const pid = found.rows[0]?.pid;
      if (pid !== undefined) {
        stuckPid = pid;
        break;
      }
      await delay(50);
    }
    if (stuckPid === undefined) {
      throw new Error('expected a stuck migration backend');
    }
    const held = await admin.query(
      `SELECT 1
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = 0
         AND objid = 185003
         AND objsubid = 1
         AND granted
         AND pid = $1
         AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database()
         )`,
      [stuckPid],
    );
    expect(held.rowCount).toBe(1);

    await expect(pending).rejects.toThrow(/Query read timeout/);

    const activity = await admin.query(
      'SELECT 1 FROM pg_stat_activity WHERE pid = $1',
      [stuckPid],
    );
    expect(activity.rowCount).toBe(0);
    const lock = await admin.query(
      `SELECT 1
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND classid = 0
         AND objid = 185003
         AND objsubid = 1
         AND granted
         AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database()
         )`,
    );
    expect(lock.rowCount).toBe(0);

    const started = Date.now();
    await migrate(pool, nextDirectory);
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    await admin
      .query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND datname = current_database()
           AND query LIKE '%pg_sleep(30)%'`,
      )
      .catch(() => undefined);
    await pool
      .query('DELETE FROM schema_migrations WHERE version = $1', [nextVersion])
      .catch(() => undefined);
    await admin.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(nextDirectory, { recursive: true, force: true });
  }
}, 20_000);

test('an upgrade renames case-variant agent names before the unique index', async () => {
  const caseUrl = databaseUrlFor('switchboard_case_test');
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(
    'DROP DATABASE IF EXISTS switchboard_case_test WITH (FORCE)',
  );
  await admin.query('CREATE DATABASE switchboard_case_test');
  const setup = new Client({ connectionString: caseUrl });
  const pool = new Pool({ connectionString: caseUrl, max: 1 });
  setup.on('error', () => undefined);
  pool.on('error', () => undefined);
  const olderToken = generateToken();
  const newerToken = generateToken();
  const thirdToken = generateToken();
  const takenToken = generateToken();
  const longKeeperToken = generateToken();
  const longRenamedToken = generateToken();
  const longKeeper = `m${'a'.repeat(63)}`;
  const longRenamed = `M${'A'.repeat(63)}`;
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    await setup.connect();
    await setup.query(
      await readFile(
        fileURLToPath(new URL('./migrations/001_init.sql', import.meta.url)),
        'utf8',
      ),
    );
    const inserted = await setup.query<{ id: string; name: string }>(
      `INSERT INTO agents (name, token_hash, created_at)
       VALUES
         ($1, $2, timestamptz '2020-01-01'),
         ($3, $4, timestamptz '2020-01-02'),
         ($5, $6, timestamptz '2020-01-03'),
         ($7, $8, timestamptz '2020-01-04'),
         ($9, $10, timestamptz '2020-01-05'),
         ($11, $12, timestamptz '2020-01-06')
       RETURNING id, name`,
      [
        'Alpha',
        hashToken(olderToken),
        'alpha',
        hashToken(newerToken),
        'ALPHA',
        hashToken(thirdToken),
        'alpha-2',
        hashToken(takenToken),
        longKeeper,
        hashToken(longKeeperToken),
        longRenamed,
        hashToken(longRenamedToken),
      ],
    );
    const idByName = new Map(inserted.rows.map((row) => [row.name, row.id]));
    const olderId = idByName.get('Alpha');
    const newerId = idByName.get('alpha');
    if (olderId === undefined || newerId === undefined) {
      throw new Error('expected both case variants');
    }
    const messages = await setup.query<{
      id: string;
      from_agent: string;
      to_agent: string;
      body: string;
    }>(
      `INSERT INTO messages (from_agent, to_agent, body)
       VALUES ($1::uuid, $2::uuid, 'older-to-newer'),
              ($2::uuid, $1::uuid, 'newer-to-older')
       RETURNING id, from_agent, to_agent, body`,
      [olderId, newerId],
    );
    await setup.query(
      `INSERT INTO message_receipts (message_id, agent_id)
       SELECT id, to_agent FROM messages`,
    );
    const receiptsBefore = await setup.query<{
      message_id: string;
      agent_id: string;
    }>(
      `SELECT message_id, agent_id
       FROM message_receipts
       ORDER BY message_id, agent_id`,
    );
    const hashesBefore = await setup.query<{ id: string; token_hash: Buffer }>(
      'SELECT id, token_hash FROM agents ORDER BY id',
    );
    await setup.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await setup.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
      '001_init.sql',
    ]);

    await migrate(pool);
    app = buildApp(caseUrl);

    const after = await setup.query<{ id: string; name: string }>(
      'SELECT id, name FROM agents ORDER BY created_at, id',
    );
    expect(after.rows.map((row) => row.id)).toEqual(
      inserted.rows.map((row) => row.id),
    );
    const renamedLong = `${longRenamed.slice(0, 62)}-2`;
    expect(after.rows.map((row) => row.name)).toEqual([
      'Alpha',
      'alpha-3',
      'ALPHA-4',
      'alpha-2',
      longKeeper,
      renamedLong,
    ]);
    expect(renamedLong).toHaveLength(64);
    expect(renamedLong).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(longKeeper).toHaveLength(64);
    const hashesAfter = await setup.query<{ id: string; token_hash: Buffer }>(
      'SELECT id, token_hash FROM agents ORDER BY id',
    );
    expect(
      hashesAfter.rows.map((row) => row.token_hash.toString('hex')),
    ).toEqual(hashesBefore.rows.map((row) => row.token_hash.toString('hex')));
    const messagesAfter = await setup.query<{
      id: string;
      from_agent: string;
      to_agent: string;
      body: string;
    }>(
      `SELECT id, from_agent, to_agent, body
       FROM messages
       ORDER BY id`,
    );
    expect(messagesAfter.rows).toEqual(
      [...messages.rows].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    );
    const receiptsAfter = await setup.query<{
      message_id: string;
      agent_id: string;
    }>(
      `SELECT message_id, agent_id
       FROM message_receipts
       ORDER BY message_id, agent_id`,
    );
    expect(receiptsAfter.rows).toEqual(receiptsBefore.rows);
    const index = await setup.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'agents_name_lower_idx'`,
    );
    expect(index.rowCount).toBe(1);
    const sentIndex = await setup.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'messages_from_agent_created_at_id_idx'`,
    );
    expect(sentIndex.rowCount).toBe(1);

    await app.migrationsReady;
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"ok":true}');
    for (const token of [olderToken, newerToken, longRenamedToken]) {
      const agents = await app.inject({
        method: 'GET',
        url: '/agents',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(agents.statusCode).toBe(200);
    }
    const listed = await app.inject({
      method: 'GET',
      url: '/agents',
      headers: { authorization: `Bearer ${olderToken}` },
    });
    const names = (listed.json() as { agents: { name: string }[] }).agents.map(
      (agent) => agent.name,
    );
    expect(names).toContain('Alpha');
    expect(names).toContain('alpha-3');
    expect(names).toContain(renamedLong);
    expect(names).not.toContain('alpha');
  } finally {
    await app?.close();
    await setup.end().catch(() => undefined);
    await pool.end();
    await admin.query(
      'DROP DATABASE IF EXISTS switchboard_case_test WITH (FORCE)',
    );
    await admin.end();
  }
});

test('closing the app unblocks a migration waiting on the database', async () => {
  const holder = new Client({ connectionString: databaseUrl });
  holder.on('error', () => undefined);
  await holder.connect();
  await holder.query('SELECT pg_advisory_lock($1::bigint)', ['185003']);
  const blocked = buildApp(databaseUrl);
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const found = await holder.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND query LIKE '%pg_advisory_lock%'
           AND state = 'active'`,
      );
      if ((found.rowCount ?? 0) > 0) {
        waiting = true;
        break;
      }
      await delay(50);
    }
    expect(waiting).toBe(true);
    const started = Date.now();
    await blocked.close();
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    await blocked.close().catch(() => undefined);
    await holder
      .query('SELECT pg_advisory_unlock($1::bigint)', ['185003'])
      .catch(() => undefined);
    await holder.end().catch(() => undefined);
  }
}, 15_000);

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

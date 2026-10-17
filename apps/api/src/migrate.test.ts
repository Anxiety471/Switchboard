import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Pool, type PoolClient } from 'pg';
import { expect, test } from 'vitest';
import { buildApp } from './app.js';
import { migrate } from './migrate.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

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
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    await setup.connect();
    await setup.query(
      await readFile(
        fileURLToPath(new URL('./migrations/001_init.sql', import.meta.url)),
        'utf8',
      ),
    );
    await setup.query(
      `INSERT INTO agents (name, token_hash, created_at)
       VALUES
         ('Alpha', decode(repeat('11', 32), 'hex'), timestamptz '2020-01-01'),
         ('alpha', decode(repeat('22', 32), 'hex'), timestamptz '2020-01-02')`,
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
    const before = await setup.query<{ id: string; name: string }>(
      'SELECT id, name FROM agents ORDER BY created_at, id',
    );

    await migrate(pool);
    app = buildApp(caseUrl);

    const after = await setup.query<{ id: string; name: string }>(
      'SELECT id, name FROM agents ORDER BY created_at, id',
    );
    expect(after.rows.map((row) => row.id)).toEqual(
      before.rows.map((row) => row.id),
    );
    expect(after.rows.map((row) => row.name)).toEqual(['Alpha', 'alpha_2']);
    const index = await setup.query(
      `SELECT 1
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname = 'agents_name_lower_idx'`,
    );
    expect(index.rowCount).toBe(1);

    await app.migrationsReady;
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"ok":true}');
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

function databaseUrlFor(name: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { expect, test } from 'vitest';
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

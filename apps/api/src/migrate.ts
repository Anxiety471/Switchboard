import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const LOCK_KEY = '185003';

async function migrationsDirectory(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'),
    join(here, '../src/migrations'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('migrations directory not found');
}

async function applyMigration(
  client: PoolClient,
  version: string,
  sql: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
      version,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const directory = await migrationsDirectory();
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      for (const file of files) {
        const found = await client.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [file],
        );
        if ((found.rowCount ?? 0) > 0) {
          continue;
        }
        const sql = await readFile(join(directory, file), 'utf8');
        await applyMigration(client, file, sql);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

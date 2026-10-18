import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Pool, type PoolClient, type QueryResult } from 'pg';

type TimeoutClient = PoolClient & {
  processID: number | null;
  connectionParameters: {
    query_timeout: number | false | undefined;
  };
};

type SqlQuery = (text: string, values?: string[]) => Promise<QueryResult>;

const LOCK_KEY = '185003';
const MIGRATION_QUERY_TIMEOUT_MS = 5 * 60 * 1000;
const STUCK_BACKEND_POLLS = 20;
const STUCK_BACKEND_POLL_MS = 25;

function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Query read timeout';
}

function destroyTimedOutClient(client: PoolClient): void {
  client.on('error', () => undefined);
  client.connection.stream.destroy();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function backendStillStuck(
  client: Client,
  pid: number,
): Promise<boolean> {
  const found = await client.query<{ stuck: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE pid = $1::int
           AND datname = current_database()
       )
       OR EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND classid = 0
           AND objid = $2::oid
           AND objsubid = 1
           AND granted
           AND pid = $1::int
       )
     ) AS stuck`,
    [pid, LOCK_KEY],
  );
  return found.rows[0]?.stuck === true;
}

async function waitForBackendRelease(
  client: Client,
  pid: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < STUCK_BACKEND_POLLS; attempt += 1) {
    if (!(await backendStillStuck(client, pid))) {
      return true;
    }
    await delay(STUCK_BACKEND_POLL_MS);
  }
  return false;
}

async function releaseStuckBackend(pool: Pool, pid: number): Promise<void> {
  const fresh = new Client(pool.options);
  fresh.on('error', () => undefined);
  await fresh.connect();
  try {
    if (!(await backendStillStuck(fresh, pid))) {
      return;
    }
    await fresh.query('SELECT pg_cancel_backend($1::int)', [pid]);
    if (await waitForBackendRelease(fresh, pid)) {
      return;
    }
    await fresh.query('SELECT pg_terminate_backend($1::int)', [pid]);
    if (!(await waitForBackendRelease(fresh, pid))) {
      throw new Error(
        `migration backend ${pid} did not release advisory lock ${LOCK_KEY}`,
      );
    }
  } finally {
    await fresh.end();
  }
}

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
  query: SqlQuery,
  abandoned: () => boolean,
  version: string,
  sql: string,
): Promise<void> {
  await query('BEGIN');
  try {
    await query(sql);
    await query('INSERT INTO schema_migrations (version) VALUES ($1)', [
      version,
    ]);
    await query('COMMIT');
  } catch (error) {
    if (!abandoned()) {
      await query('ROLLBACK');
    }
    throw error;
  }
}

export async function migrate(
  pool: Pool,
  directory?: string,
  queryTimeoutMs = MIGRATION_QUERY_TIMEOUT_MS,
): Promise<void> {
  const resolved = directory ?? (await migrationsDirectory());
  const files = (await readdir(resolved))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const client = await pool.connect();
  const timed = client as TimeoutClient;
  const backendPid = timed.processID;
  const queryTimeout = timed.connectionParameters.query_timeout;
  // node-pg reads connectionParameters.query_timeout; the pg_sleep(3) test guards it.
  timed.connectionParameters.query_timeout = queryTimeoutMs;
  let discard: Error | undefined;
  let abandoned = false;

  const query: SqlQuery = async (text, values) => {
    if (abandoned) {
      throw discard ?? new Error('Query read timeout');
    }
    try {
      if (values === undefined) {
        return await client.query(text);
      }
      return await client.query(text, values);
    } catch (error) {
      if (!abandoned && isQueryReadTimeout(error)) {
        abandoned = true;
        discard =
          error instanceof Error ? error : new Error('Query read timeout');
        destroyTimedOutClient(client);
      }
      throw error;
    }
  };

  try {
    await query('SET statement_timeout = 0');
    try {
      await query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
          )
        `);
        for (const file of files) {
          const found = await query(
            'SELECT 1 FROM schema_migrations WHERE version = $1',
            [file],
          );
          if ((found.rowCount ?? 0) > 0) {
            continue;
          }
          const sql = await readFile(join(resolved, file), 'utf8');
          await applyMigration(query, () => abandoned, file, sql);
        }
      } finally {
        if (!abandoned) {
          await query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
        }
      }
    } finally {
      if (!abandoned) {
        try {
          await query('RESET statement_timeout');
        } catch (error) {
          if (!abandoned) {
            discard =
              error instanceof Error
                ? error
                : new Error('reset statement_timeout failed');
          }
        }
      }
    }
  } finally {
    timed.connectionParameters.query_timeout = queryTimeout;
    if (discard === undefined) {
      client.release();
    } else {
      client.release(discard);
    }
    if (abandoned && typeof backendPid === 'number' && backendPid > 0) {
      await releaseStuckBackend(pool, backendPid);
    }
  }
}

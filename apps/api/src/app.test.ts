import { Client } from 'pg';
import { afterAll, expect, test } from 'vitest';
import { buildApp, parsePort } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const app = buildApp(databaseUrl);

afterAll(async () => {
  await app.close();
});

test('parsePort accepts integers from 1 to 65535', () => {
  expect(parsePort(undefined)).toBe(3001);
  expect(parsePort('3001')).toBe(3001);
  expect(parsePort('1')).toBe(1);
  expect(parsePort('65535')).toBe(65535);
  expect(() => parsePort('0')).toThrow(/1 to 65535/);
  expect(() => parsePort('65536')).toThrow(/1 to 65535/);
  expect(() => parsePort('3001.5')).toThrow(/1 to 65535/);
  expect(() => parsePort('nope')).toThrow(/1 to 65535/);
});

test('GET /health queries postgres', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test('GET /health returns 503 when postgres is unreachable', async () => {
  const down = buildApp(
    'postgres://switchboard_user:s3cret-pass@127.0.0.1:1/switchboard_db',
  );

  try {
    const address = await down.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/health`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ ok: false });
    expect(body).not.toMatch(
      /ECONNREFUSED|switchboard_user|s3cret-pass|switchboard_db|127\.0\.0\.1/,
    );
  } finally {
    await down.close();
  }
});

test('GET /health survives pg_terminate_backend', async () => {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', 'switchboard_terminate_test');
  const terminated = buildApp(url.toString(), { max: 1 });
  const admin = new Client({ connectionString: databaseUrl });

  try {
    await admin.connect();
    const address = await terminated.listen({ host: '127.0.0.1', port: 0 });
    const warm = await fetch(`${address}/health`);
    expect(warm.status).toBe(200);

    let failureBody: string | undefined;
    for (
      let attempt = 0;
      attempt < 15 && failureBody === undefined;
      attempt += 1
    ) {
      const ready = await terminated.inject({ method: 'GET', url: '/health' });
      expect(ready.statusCode).toBe(200);

      const killed = await admin.query<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
         WHERE application_name = $1
           AND pid <> pg_backend_pid()`,
        ['switchboard_terminate_test'],
      );
      expect(killed.rowCount ?? 0).toBeGreaterThan(0);

      const response = await terminated.inject({
        method: 'GET',
        url: '/health',
      });
      if (response.statusCode === 200) {
        continue;
      }
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false });
      expect(response.body).not.toMatch(
        /administrator|terminating|ECONNRESET|57P01|switchboard_terminate_test/i,
      );
      failureBody = response.body;
    }
    expect(failureBody).toBe('{"ok":false}');

    const recovered = await terminated.inject({
      method: 'GET',
      url: '/health',
    });
    expect(recovered.statusCode).toBe(200);
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE application_name = $1
         AND pid <> pg_backend_pid()`,
      ['switchboard_terminate_test'],
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(terminated.server.listening).toBe(true);
  } finally {
    await admin.end();
    await terminated.close();
  }
});

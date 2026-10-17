import { Client } from 'pg';
import { afterAll, expect, test } from 'vitest';
import { buildApp, parsePort } from './app.js';
import { startHoldingProxy } from './test-helpers/holding-proxy.js';

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
    { migrate: false },
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
  const upstream = new URL(databaseUrl);
  const proxy = await startHoldingProxy(
    upstream.hostname,
    upstream.port ? Number(upstream.port) : 5432,
  );
  const proxied = new URL(databaseUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(proxy.port);
  proxied.searchParams.set('application_name', 'switchboard_terminate_test');
  proxied.searchParams.set('sslmode', 'disable');
  const terminated = buildApp(proxied.toString(), { max: 1 });
  const admin = new Client({ connectionString: databaseUrl });
  let pending: Promise<Response> | undefined;

  try {
    await admin.connect();
    const address = await terminated.listen({ host: '127.0.0.1', port: 0 });
    const warm = await fetch(`${address}/health`);
    expect(warm.status).toBe(200);
    expect(proxy.connectionCount()).toBe(1);

    const active = await admin.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE application_name = $1
         AND pid <> pg_backend_pid()`,
      ['switchboard_terminate_test'],
    );
    expect(active.rowCount).toBe(1);

    const armed = proxy.arm();
    pending = fetch(`${address}/health`);
    await armed;

    const killed = await admin.query<{ terminated: boolean }>(
      `SELECT pg_terminate_backend(pid) AS terminated
       FROM pg_stat_activity
       WHERE application_name = $1
         AND pid <> pg_backend_pid()`,
      ['switchboard_terminate_test'],
    );
    expect(killed.rows.some((row) => row.terminated)).toBe(true);
    proxy.dropHeld();

    const response = await pending;
    pending = undefined;
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toBe('{"ok":false}');
    expect(body).not.toMatch(
      /administrator|terminating|ECONNRESET|57P01|switchboard_terminate_test/i,
    );

    const recovered = await fetch(`${address}/health`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ ok: true });
    expect(terminated.server.listening).toBe(true);
  } finally {
    await pending?.catch(() => undefined);
    await admin.end().catch(() => undefined);
    await terminated.close();
    await proxy.close();
  }
});

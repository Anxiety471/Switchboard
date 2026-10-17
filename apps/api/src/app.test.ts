import { connect, createServer, type Server } from 'node:net';
import { Client } from 'pg';
import { afterAll, expect, test } from 'vitest';
import { buildApp, parseHost, parsePort } from './app.js';
import { startHoldingProxy } from './test-helpers/holding-proxy.js';
import { assertTestDatabaseUrl } from './test-helpers/test-database.js';

const databaseUrl = assertTestDatabaseUrl(process.env.TEST_DATABASE_URL);

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

test('parseHost defaults to loopback', () => {
  expect(parseHost(undefined)).toBe('127.0.0.1');
  expect(parseHost('')).toBe('127.0.0.1');
  expect(parseHost('0.0.0.0')).toBe('0.0.0.0');
});

test('GET /health queries postgres', async () => {
  await app.migrationsReady;
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test('GET /health returns 503 when postgres is unreachable', async () => {
  const down = buildApp(
    'postgres://switchboard_user:s3cret-pass@127.0.0.1:1/unreachable_test',
  );

  try {
    const address = await down.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/health`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe('{"ok":false}');
    expect(body).not.toMatch(
      /ECONNREFUSED|switchboard_user|s3cret-pass|unreachable_test|127\.0\.0\.1/,
    );
    expect(down.server.listening).toBe(true);

    const agents = await fetch(`${address}/agents`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    const agentsBody = await agents.text();
    expect(agents.status).toBe(503);
    expect(agentsBody).toBe('{"ok":false}');
    expect(agentsBody).not.toMatch(
      /ECONNREFUSED|switchboard_user|s3cret-pass|unreachable_test|not-a-real-token/,
    );
    expect(down.server.listening).toBe(true);
  } finally {
    await down.close();
  }
});

test('the same process recovers after postgres returns', async () => {
  const upstream = new URL(databaseUrl);
  const port = await freePort();
  const proxied = new URL(databaseUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);
  proxied.searchParams.set('sslmode', 'disable');
  const recovering = buildApp(proxied.toString());
  let forwarder: Server | undefined;

  try {
    const address = await recovering.listen({ host: '127.0.0.1', port: 0 });
    const down = await fetch(`${address}/health`);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe('{"ok":false}');

    const agents = await fetch(`${address}/agents`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(agents.status).toBe(503);
    expect(await agents.text()).toBe('{"ok":false}');
    expect(recovering.server.listening).toBe(true);

    forwarder = await forwardTo(
      port,
      upstream.hostname,
      upstream.port ? Number(upstream.port) : 5432,
    );
    let recovered = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`${address}/health`);
      const body = await response.text();
      if (response.status === 200) {
        expect(body).toBe('{"ok":true}');
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(recovered).toBe(true);
    expect(recovering.server.listening).toBe(true);
  } finally {
    await recovering.close();
    await closeServer(forwarder);
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
    await terminated.migrationsReady;
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

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected a port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function forwardTo(
  port: number,
  upstreamHost: string,
  upstreamPort: number,
): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect(upstreamPort, upstreamHost);
    client.on('error', () => {
      upstream.destroy();
    });
    upstream.on('error', () => {
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

import { afterAll, expect, test } from 'vitest';
import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const app = buildApp(databaseUrl);

afterAll(async () => {
  await app.close();
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

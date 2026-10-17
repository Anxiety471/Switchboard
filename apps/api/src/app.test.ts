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

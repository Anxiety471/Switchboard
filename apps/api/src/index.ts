import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const port = Number(process.env.PORT ?? '3001');
const app = buildApp(databaseUrl);

await app.listen({ host: '0.0.0.0', port });

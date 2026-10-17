import Fastify from 'fastify';
import { Pool } from 'pg';

export function buildApp(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const app = Fastify();

  app.get('/health', async () => {
    const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    const row = result.rows[0];
    if (row?.ok !== 1) {
      throw new Error('database check failed');
    }
    return { ok: true };
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}

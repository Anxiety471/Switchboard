import Fastify from 'fastify';
import { Pool } from 'pg';

export function buildApp(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
  });
  const app = Fastify({ logger: true });

  app.get('/health', async (_request, reply) => {
    try {
      const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      const row = result.rows[0];
      if (row?.ok !== 1) {
        app.log.error({ row }, 'database health check failed');
        return reply.code(503).send({ ok: false });
      }
      return { ok: true };
    } catch (error) {
      app.log.error(error, 'database health check failed');
      return reply.code(503).send({ ok: false });
    }
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}

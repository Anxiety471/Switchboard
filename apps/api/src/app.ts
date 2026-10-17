import Fastify from 'fastify';
import { Pool } from 'pg';

export type BuildAppOptions = {
  logger?: boolean;
  max?: number;
};

export function buildApp(databaseUrl: string, options?: BuildAppOptions) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2000,
    max: options?.max ?? 10,
  });
  const app = Fastify({ logger: options?.logger ?? false });

  pool.on('error', (error) => {
    app.log.error(error, 'idle database client error');
  });

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

export function parsePort(value: string | undefined): number {
  const raw = value ?? '3001';
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 65535) {
    throw new Error(
      `Invalid PORT ${JSON.stringify(value)}: expected an integer from 1 to 65535`,
    );
  }
  return Number(raw);
}

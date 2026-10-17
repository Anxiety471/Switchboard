import { buildApp } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const port = parsePort(process.env.PORT);
const app = buildApp(databaseUrl);

await app.listen({ host: '0.0.0.0', port });

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  app
    .close()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      app.log.error(error, 'shutdown failed');
      process.exit(1);
    });
}

process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});

function parsePort(value: string | undefined): number {
  const raw = value ?? '3001';
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
    throw new Error(
      `Invalid PORT ${JSON.stringify(value)}: expected an integer from 0 to 65535`,
    );
  }
  return Number(raw);
}

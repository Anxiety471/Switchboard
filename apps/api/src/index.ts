import { buildApp, parsePort } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const port = parsePort(process.env.PORT);
const app = buildApp(databaseUrl, { logger: true });

await app.listen({ host: '0.0.0.0', port });

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => {
    process.exit(1);
  }, 5000);
  forceExit.unref();
  app
    .close()
    .then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    })
    .catch((error: unknown) => {
      clearTimeout(forceExit);
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

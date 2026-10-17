import { buildApp, parseHost, parsePort } from './app.js';
import { enforceRuntimeSecrets } from './options.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const port = parsePort(process.env.PORT);
const app = buildApp(databaseUrl, {
  logger: true,
  ...enforceRuntimeSecrets(process.env),
});

await app.listen({ host: parseHost(process.env.HOST), port });

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => {
    app.log.error('shutdown timed out; forcing exit');
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

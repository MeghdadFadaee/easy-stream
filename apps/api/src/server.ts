import { buildApp } from './app.js';
import { loadConfig } from './config.js';

for (const candidate of [process.env.ENV_FILE, '.env', '../../.env']) {
  if (!candidate) continue;
  try {
    process.loadEnvFile?.(candidate);
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exitCode = 0;
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
}

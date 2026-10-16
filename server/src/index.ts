import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { logger } from './logger.js';
import { closeRealtime, initRealtime } from './realtime.js';
import { startWorkers, stopWorkers } from './services/monitor.service.js';
import { syncIndexes } from './scripts/indexes.js';

async function main() {
  await connectDatabase();
  await syncIndexes();
  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);
  startWorkers();
  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV, email: config.EMAIL_MODE, sso: config.ssoEnabled }, 'API listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopWorkers();
    closeRealtime();
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});

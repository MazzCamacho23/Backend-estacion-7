import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { closeRealtime, initRealtime } from './realtime/socket';

async function main() {
  await prisma.$connect();

  const app = createApp();
  const server = http.createServer(app);
  initRealtime(server);

  server.listen(env.PORT, () => {
    logger.info(`☕ Estación Siete API escuchando en http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  // Apagado ordenado: deja terminar las peticiones en curso (ventas a medio commit).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Apagando servidor...');
    const force = setTimeout(() => process.exit(1), 15_000).unref();
    await closeRealtime();
    server.close(async () => {
      await prisma.$disconnect();
      clearTimeout(force);
      logger.info('Servidor detenido');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'No se pudo iniciar el servidor');
  process.exit(1);
});

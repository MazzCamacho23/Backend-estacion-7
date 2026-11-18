import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { toPlain } from './lib/serialize';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Detrás de Railway/Render/Nginx: IP real para el rate limit

  app.use(helmet());
  app.use(cors({ origin: corsOrigins }));
  // Tolerancia: algunos clientes envían "charset=UTF8" (sin guion), que el parser
  // de Express rechaza. Se normaliza a "utf-8" antes de parsear.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const ct = req.headers['content-type'];
    if (ct && /charset=["']?utf8["']?/i.test(ct)) {
      req.headers['content-type'] = ct.replace(/charset=["']?utf8["']?/i, 'charset=utf-8');
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/v1/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  // Decimal/BigInt -> number en todas las respuestas JSON.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(toPlain(body));
    next();
  });

  // Chequeo de salud público. Disponible en /health y en /api/v1/health
  // (los clientes suelen armarlo sobre la BASE_URL de la API).
  const health = async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down', time: new Date().toISOString() });
    }
  };
  app.get('/health', health);
  app.get('/api/v1/health', health);

  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

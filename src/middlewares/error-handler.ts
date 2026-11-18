import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Formato único de error para el cliente:
 * { "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": {...} } }
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Datos inválidos',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: { code: 'DUPLICATE', message: 'Ya existe un registro con esos datos', details: err.meta },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado' } });
    }
    if (err.code === 'P2003') {
      return res.status(409).json({
        error: { code: 'FK_CONSTRAINT', message: 'El registro está en uso o referencia algo inexistente' },
      });
    }
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON mal formado' } });
  }

  // Errores del parser de Express (body-parser): charset, tamaño, encoding...
  const httpErr = err as { status?: number; type?: string; message?: string };
  if (typeof httpErr.status === 'number' && httpErr.status >= 400 && httpErr.status < 500 && httpErr.type) {
    const codes: Record<string, string> = {
      'charset.unsupported': 'UNSUPPORTED_CHARSET',
      'encoding.unsupported': 'UNSUPPORTED_ENCODING',
      'entity.too.large': 'PAYLOAD_TOO_LARGE',
      'request.aborted': 'REQUEST_ABORTED',
    };
    return res.status(httpErr.status).json({
      error: {
        code: codes[httpErr.type] ?? 'BAD_REQUEST',
        message: httpErr.message ?? 'Petición inválida',
      },
    });
  }

  logger.error({ err, method: req.method, url: req.originalUrl }, 'Error no controlado');
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' } });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `Ruta no existe: ${req.method} ${req.path}` } });
}

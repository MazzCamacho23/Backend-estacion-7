import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { type AuthUser, verifyAccessToken } from '../lib/tokens';

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('Falta el token de acceso');
  try {
    req.user = verifyAccessToken(header.slice(7));
  } catch {
    // El cliente debe intentar POST /auth/refresh al recibir este código.
    throw new AppError(401, 'TOKEN_EXPIRED_OR_INVALID', 'Sesión expirada, vuelve a autenticarte');
  }
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

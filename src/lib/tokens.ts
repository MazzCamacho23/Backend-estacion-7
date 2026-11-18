import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

const ISSUER = 'estacion-siete-api';

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ name: user.name, role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    issuer: ISSUER,
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER }) as jwt.JwtPayload & {
    name?: string;
    role?: Role;
  };
  if (!payload.sub || !payload.role || !payload.name) throw new Error('Token mal formado');
  return { id: payload.sub, name: payload.name, role: payload.role };
}

/** Refresh token opaco (no JWT). En BD solo se guarda su hash SHA-256. */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

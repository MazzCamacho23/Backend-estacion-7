import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { AppError, unauthorized } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { generateRefreshToken, hashToken, signAccessToken } from '../../lib/tokens';

export const BCRYPT_ROUNDS = 12;

// Hash ficticio para que un email inexistente tarde lo mismo que uno real
// (evita adivinar qué correos están registrados midiendo el tiempo).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export function publicUser(u: User) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, createdAt: u.createdAt };
}

async function issueSession(user: User) {
  const { token, hash } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return {
    accessToken: signAccessToken({ id: user.id, name: user.name, role: user.role }),
    accessTokenExpiresIn: env.JWT_ACCESS_TTL_SECONDS,
    refreshToken: token,
    user: publicUser(user),
  };
}

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Correo o contraseña incorrectos', 'INVALID_CREDENTIALS');
  if (!user.isActive) throw new AppError(403, 'USER_DISABLED', 'Tu usuario está deshabilitado');
  return issueSession(user);
}

/** Rotación: cada refresh invalida el token usado y entrega uno nuevo. */
export async function refresh(refreshToken: string) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });
  if (!stored) throw unauthorized('Sesión inválida', 'INVALID_REFRESH_TOKEN');

  if (stored.revokedAt) {
    // Alguien reutilizó un token ya rotado: posible robo. Se cierran todas las sesiones.
    logger.warn({ userId: stored.userId }, 'Reutilización de refresh token detectada');
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Sesión inválida', 'INVALID_REFRESH_TOKEN');
  }
  if (stored.expiresAt < new Date()) throw unauthorized('Sesión expirada', 'REFRESH_TOKEN_EXPIRED');
  if (!stored.user.isActive) throw new AppError(403, 'USER_DISABLED', 'Tu usuario está deshabilitado');

  const revoked = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (revoked.count === 0) throw unauthorized('Sesión inválida', 'INVALID_REFRESH_TOKEN');

  return issueSession(stored.user);
}

export async function logout(refreshToken: string) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function me(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized();
  // El access token es válido 15 min aunque el usuario se desactive; /me es el
  // punto donde la app valida la sesión al abrir, así que aquí se corta.
  if (!user.isActive) throw new AppError(403, 'USER_DISABLED', 'Tu usuario está deshabilitado');
  return publicUser(user);
}

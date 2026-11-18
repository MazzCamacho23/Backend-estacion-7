import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { uuidParam } from '../../lib/validation';
import { currentUser } from '../../middlewares/auth';
import { BCRYPT_ROUNDS, publicUser } from '../auth/auth.service';

/** Gestión de usuarios. Montado solo para OWNER (ver routes.ts). */
export const usersRouter = Router();

const password = z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(100);

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  password,
  role: z.nativeEnum(Role).default(Role.EMPLOYEE),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  email: z.string().email().transform((e) => e.toLowerCase().trim()).optional(),
  role: z.nativeEnum(Role).optional(),
  isActive: z.boolean().optional(),
  password: password.optional(),
});

usersRouter.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  res.json(users.map(publicUser));
});

usersRouter.post('/', async (req, res) => {
  const data = createSchema.parse(req.body);
  const user = await prisma.user.create({
    data: {
      name: data.name,
      email: data.email,
      role: data.role,
      passwordHash: await bcrypt.hash(data.password, BCRYPT_ROUNDS),
    },
  });
  res.status(201).json(publicUser(user));
});

usersRouter.patch('/:id', async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const data = updateSchema.parse(req.body);
  const me = currentUser(req);

  if (id === me.id && (data.isActive === false || (data.role && data.role !== Role.OWNER))) {
    throw badRequest('No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  }
  const exists = await prisma.user.findUnique({ where: { id } });
  if (!exists) throw notFound('Usuario no encontrado');

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id },
      data: {
        name: data.name,
        email: data.email,
        role: data.role,
        isActive: data.isActive,
        passwordHash: data.password ? await bcrypt.hash(data.password, BCRYPT_ROUNDS) : undefined,
      },
    });
    // Desactivar o cambiar contraseña cierra todas sus sesiones.
    if (data.isActive === false || data.password) {
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return updated;
  });
  res.json(publicUser(user));
});

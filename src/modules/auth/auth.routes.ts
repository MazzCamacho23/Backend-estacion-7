import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, currentUser } from '../../middlewares/auth';
import * as auth from './auth.service';

export const authRouter = Router();

// Frena ataques de fuerza bruta: 10 intentos por IP cada 15 min.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Demasiados intentos, espera unos minutos' } },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
const refreshSchema = z.object({ refreshToken: z.string().min(20) });

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  res.json(await auth.login(email, password));
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  res.json(await auth.refresh(refreshToken));
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  await auth.logout(refreshToken);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await auth.me(currentUser(req).id));
});

import { Router } from 'express';
import { z } from 'zod';
import { dateKeySchema, queryBool, uuidParam } from '../../lib/validation';
import { currentUser, requireRole } from '../../middlewares/auth';
import * as svc from './shifts.service';

export const shiftsRouter = Router();

const cash = z.number().int().min(0).max(100_000_000);

shiftsRouter.post('/open', async (req, res) => {
  const { startingCash } = z.object({ startingCash: cash }).parse(req.body);
  res.status(201).json(await svc.openShift(currentUser(req), startingCash));
});

/** Turno abierto del usuario autenticado: { shift: {...} | null } */
shiftsRouter.get('/current', async (req, res) => {
  res.json(await svc.getCurrentShift(currentUser(req)));
});

/** Resumen completo del turno abierto (ventas, pagos, efectivo esperado, productos): { shift: null } si no hay. */
shiftsRouter.get('/current/summary', async (req, res) => {
  res.json(await svc.getCurrentShiftSummary(currentUser(req)));
});

/** Resumen completo de cualquier turno (el vendedor solo los suyos). */
shiftsRouter.get('/:id/summary', async (req, res) => {
  res.json(await svc.getShiftSummaryById(uuidParam.parse(req.params).id, currentUser(req)));
});

shiftsRouter.get('/', async (req, res) => {
  const q = z
    .object({
      from: dateKeySchema.optional(),
      to: dateKeySchema.optional(),
      sellerId: z.string().uuid().optional(),
      open: queryBool,
    })
    .parse(req.query);
  res.json(await svc.listShifts(q, currentUser(req)));
});

shiftsRouter.get('/:id', async (req, res) => {
  res.json(await svc.getShift(uuidParam.parse(req.params).id, currentUser(req)));
});

shiftsRouter.post('/:id/close', async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z.object({ countedCash: cash, notes: z.string().max(500).nullish() }).parse(req.body);
  res.json(await svc.closeShift(id, body, currentUser(req)));
});

shiftsRouter.post('/:id/reopen', requireRole('OWNER'), async (req, res) => {
  res.json(await svc.reopenShift(uuidParam.parse(req.params).id));
});

import { Router } from 'express';
import { SaleStatus } from '@prisma/client';
import { z } from 'zod';
import { dateKeySchema, paginationSchema, queryBool, uuidParam } from '../../lib/validation';
import { currentUser, requireRole } from '../../middlewares/auth';
import * as svc from './sales.service';

export const salesRouter = Router();

/**
 * Checkout. 201 = venta nueva, 200 = reintento de una venta ya registrada
 * (mismo clientRequestId): el cliente puede tratar ambos como éxito.
 */
salesRouter.post('/', async (req, res) => {
  const input = svc.checkoutSchema.parse(req.body);
  const { sale, replayed } = await svc.checkout(input, currentUser(req));
  res.status(replayed ? 200 : 201).json(sale);
});

salesRouter.get('/', async (req, res) => {
  const q = paginationSchema
    .extend({
      from: dateKeySchema.optional(),
      to: dateKeySchema.optional(),
      sellerId: z.string().uuid().optional(),
      shiftId: z.string().uuid().optional(),
      status: z.nativeEnum(SaleStatus).optional(),
      isCourtesy: queryBool,
    })
    .parse(req.query);
  res.json(await svc.listSales(q, currentUser(req)));
});

/** Acepta UUID o número de ticket: /sales/1058 */
salesRouter.get('/:id', async (req, res) => {
  const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
  res.json(await svc.getSale(id, currentUser(req)));
});

salesRouter.post('/:id/refund', requireRole('OWNER'), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z
    .object({ reason: z.string().trim().min(3).max(300), restock: z.boolean().default(false) })
    .parse(req.body);
  res.json(await svc.refundSale(id, body, currentUser(req)));
});

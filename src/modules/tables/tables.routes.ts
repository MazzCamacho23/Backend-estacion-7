import { Router } from 'express';
import { z } from 'zod';
import { updatedSinceSchema, uuidParam } from '../../lib/validation';
import { currentUser } from '../../middlewares/auth';
import { lineInputSchema } from '../sales/pricing';
import * as svc from './tables.service';

/**
 * Mesas / cuentas abiertas. Cualquier vendedor puede operar cualquier mesa
 * (atención compartida). El cobro se hace con POST /sales { openTableId }.
 */
export const tablesRouter = Router();

const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });
const label = z.string().trim().min(1).max(60);

tablesRouter.get('/', async (req, res) => {
  const { updatedSince } = z.object({ updatedSince: updatedSinceSchema }).parse(req.query);
  res.json(await svc.listOpenTables(updatedSince));
});

tablesRouter.get('/:id', async (req, res) => {
  res.json(await svc.getTable(uuidParam.parse(req.params).id));
});

tablesRouter.post('/', async (req, res) => {
  const body = z
    .object({
      label,
      notes: z.string().max(300).nullish(),
      items: z.array(lineInputSchema).max(100).default([]),
    })
    .parse(req.body);
  res.status(201).json(await svc.openTable(body, currentUser(req)));
});

tablesRouter.patch('/:id', async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = z.object({ label: label.optional(), notes: z.string().max(300).nullish() }).parse(req.body);
  res.json(await svc.updateTable(id, body));
});

tablesRouter.post('/:id/items', async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { items } = z.object({ items: z.array(lineInputSchema).min(1).max(100) }).parse(req.body);
  res.status(201).json(await svc.addItems(id, items, currentUser(req)));
});

tablesRouter.patch('/:id/items/:itemId', async (req, res) => {
  const { id, itemId } = itemParams.parse(req.params);
  const body = z
    .object({
      quantity: z.number().int().min(1).max(100).optional(),
      observations: z.string().max(300).nullish(),
    })
    .parse(req.body);
  res.json(await svc.updateItem(id, itemId, body));
});

tablesRouter.delete('/:id/items/:itemId', async (req, res) => {
  const { id, itemId } = itemParams.parse(req.params);
  res.json(await svc.removeItem(id, itemId));
});

tablesRouter.delete('/:id', async (req, res) => {
  res.json(await svc.cancelTable(uuidParam.parse(req.params).id));
});

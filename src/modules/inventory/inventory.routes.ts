import { Router } from 'express';
import { InventoryItemType, InventoryLocation, MovementType } from '@prisma/client';
import { z } from 'zod';
import { dateKeySchema, idParam, paginationSchema, queryBool, updatedSinceSchema } from '../../lib/validation';
import { currentUser, requireRole } from '../../middlewares/auth';
import { presentItem } from './inventory.ledger';
import * as svc from './inventory.service';

export const inventoryRouter = Router();

const UNITS = ['g', 'ml', 'unidad', 'oz', 'kg', 'L'] as const;
const qty = z.number().positive().max(1_000_000);

const listQuery = z.object({
  location: z.nativeEnum(InventoryLocation).optional(),
  active: queryBool,
  lowStock: queryBool,
  updatedSince: updatedSinceSchema,
});

const createBody = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,64}$/).optional(),
  baseKey: z.string().regex(/^[a-z0-9_-]{2,60}$/, 'Usa minúsculas, números, _ o - (ej: vaso_carton_7)'),
  name: z.string().trim().min(2).max(120),
  type: z.nativeEnum(InventoryItemType),
  location: z.nativeEnum(InventoryLocation),
  minimumStock: z.number().min(0).default(0),
  unit: z.enum(UNITS),
  unitCost: z.number().min(0).default(0),
  supplier: z.string().max(120).nullish(),
  initialStock: z.number().min(0).default(0),
});

const updateBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.nativeEnum(InventoryItemType),
    minimumStock: z.number().min(0),
    unit: z.enum(UNITS),
    unitCost: z.number().min(0),
    supplier: z.string().max(120).nullable(),
    isActive: z.boolean(),
  })
  .partial();

const movementsQuery = paginationSchema.extend({
  itemId: z.string().optional(),
  type: z.nativeEnum(MovementType).optional(),
  saleId: z.string().uuid().optional(),
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});

// --- Insumos ---------------------------------------------------------------

inventoryRouter.get('/items', async (req, res) => {
  const role = currentUser(req).role;
  res.json((await svc.listItems(listQuery.parse(req.query))).map((i) => presentItem(i, role)));
});

inventoryRouter.get('/items/:id', async (req, res) => {
  res.json(presentItem(await svc.getItem(idParam.parse(req.params).id), currentUser(req).role));
});

inventoryRouter.post('/items', requireRole('OWNER'), async (req, res) => {
  res.status(201).json(await svc.createItem(createBody.parse(req.body), currentUser(req)));
});

/** Edita datos del insumo. El stock NO se edita aquí: solo vía movimientos. */
inventoryRouter.patch('/items/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await svc.updateItem(id, updateBody.parse(req.body)));
});

// --- Movimientos -----------------------------------------------------------

inventoryRouter.get('/movements', requireRole('OWNER'), async (req, res) => {
  res.json(await svc.listMovements(movementsQuery.parse(req.query)));
});

inventoryRouter.post('/movements/input', requireRole('OWNER'), async (req, res) => {
  const body = z
    .object({
      itemId: z.string().min(1),
      quantity: qty,
      unitCost: z.number().min(0).optional(),
      supplier: z.string().max(120).optional(),
      reason: z.string().max(300).optional(),
    })
    .parse(req.body);
  res.status(201).json(await svc.registerInput(body, currentUser(req)));
});

inventoryRouter.post('/movements/output', requireRole('OWNER'), async (req, res) => {
  const body = z
    .object({ itemId: z.string().min(1), quantity: qty, reason: z.string().trim().min(3).max(300) })
    .parse(req.body);
  res.status(201).json(await svc.registerOutput(body, currentUser(req)));
});

/** Vendedores también pueden traer mercancía de bodega al punto de venta. */
inventoryRouter.post('/movements/transfer', async (req, res) => {
  const body = z
    .object({ baseKey: z.string().min(1), quantity: qty, reason: z.string().max(300).optional() })
    .parse(req.body);
  const user = currentUser(req);
  const r = await svc.transferWarehouseToPos(body, user);
  res.status(201).json({ ...r, items: r.items.map((i) => presentItem(i, user.role)) });
});

inventoryRouter.post('/movements/adjustment', requireRole('OWNER'), async (req, res) => {
  const body = z
    .object({
      itemId: z.string().min(1),
      countedStock: z.number().min(0),
      reason: z.string().trim().min(3).max(300),
    })
    .parse(req.body);
  res.status(201).json(await svc.adjustToCount(body, currentUser(req)));
});

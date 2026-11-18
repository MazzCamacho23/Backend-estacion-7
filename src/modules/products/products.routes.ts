import { Router } from 'express';
import { z } from 'zod';
import { idParam, queryBool, updatedSinceSchema } from '../../lib/validation';
import { requireRole } from '../../middlewares/auth';
import * as svc from './products.service';

export const productsRouter = Router();

export const PRODUCT_CATEGORIES = [
  'Bebidas Calientes',
  'Bebidas Frías',
  'Especiales 7',
  'Especiales con Licor',
  'Adiciones',
  'Leches',
  'Para Acompañar',
] as const;

const listQuery = z.object({
  category: z.string().optional(),
  active: queryBool,
  updatedSince: updatedSinceSchema,
});

const productBody = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]{2,64}$/, 'Usa minúsculas, números, _ o - (ej: americano_7oz)')
    .optional(),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(60),
  price: z.number().int().min(0),
  isActive: z.boolean().optional(),
  description: z.string().max(500).nullish(),
  preparationTimeSeconds: z.number().int().min(0).max(3600).optional(),
  /** Solo para la categoría "Leches": insumo POS que reemplaza la leche base. */
  milkInventoryItemId: z.string().min(1).max(64).nullish(),
});

const recipeBody = z.object({
  preparationTimeSeconds: z.number().int().min(0).max(3600).default(0),
  isActive: z.boolean().default(true),
  ingredients: z
    .array(
      z.object({
        ingredientId: z.string().min(1),
        quantity: z.number().positive(),
        isMilk: z.boolean().default(false),
      }),
    )
    .max(50),
});

productsRouter.get('/categories', (_req, res) => {
  res.json(PRODUCT_CATEGORIES);
});

productsRouter.get('/', async (req, res) => {
  res.json(await svc.listProducts(listQuery.parse(req.query)));
});

productsRouter.get('/:id', async (req, res) => {
  res.json(await svc.getProduct(idParam.parse(req.params).id));
});

productsRouter.post('/', requireRole('OWNER'), async (req, res) => {
  res.status(201).json(await svc.createProduct(productBody.parse(req.body)));
});

productsRouter.patch('/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await svc.updateProduct(id, productBody.omit({ id: true }).partial().parse(req.body)));
});

/** Interruptor On/Off rápido del administrador. */
productsRouter.patch('/:id/active', requireRole('OWNER'), async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  res.json(await svc.updateProduct(id, { isActive }));
});

productsRouter.get('/:id/recipe', async (req, res) => {
  res.json(await svc.getRecipe(idParam.parse(req.params).id));
});

productsRouter.put('/:id/recipe', requireRole('OWNER'), async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await svc.upsertRecipe(id, recipeBody.parse(req.body)));
});

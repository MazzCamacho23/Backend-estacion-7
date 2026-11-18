import { Router } from 'express';
import { z } from 'zod';
import { dateRangeSchema } from '../../lib/validation';
import * as svc from './reports.service';

/** Montado solo para OWNER. Rango por defecto: hoy. */
export const reportsRouter = Router();

reportsRouter.get('/sales-summary', async (req, res) => {
  const { from, to } = dateRangeSchema.parse(req.query);
  res.json(await svc.salesSummary(from, to));
});

reportsRouter.get('/top-products', async (req, res) => {
  const { from, to, limit } = dateRangeSchema
    .extend({ limit: z.coerce.number().int().min(1).max(100).default(20) })
    .parse(req.query);
  res.json(await svc.topProducts(from, to, limit));
});

reportsRouter.get('/sales-by-seller', async (req, res) => {
  const { from, to } = dateRangeSchema.parse(req.query);
  res.json(await svc.salesBySeller(from, to));
});

reportsRouter.get('/sales-by-hour', async (req, res) => {
  const { from, to } = dateRangeSchema.parse(req.query);
  res.json(await svc.salesByHour(from, to));
});

reportsRouter.get('/courtesies', async (req, res) => {
  const { from, to } = dateRangeSchema.parse(req.query);
  res.json(await svc.courtesies(from, to));
});

reportsRouter.get('/inventory-valuation', async (_req, res) => {
  res.json(await svc.inventoryValuation());
});

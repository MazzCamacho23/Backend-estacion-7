import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { toPlain } from '../../lib/serialize';
import { businessRange } from '../../lib/time';

/**
 * Reportes con SQL directo: agregaciones que con el ORM serían lentas o
 * imposibles (agrupar por día/hora en hora Colombia, FILTER, etc.).
 * Todos los montos en COP. Solo cuentan ventas APPROVED.
 */

const TZ = env.BUSINESS_TIMEZONE;

function range(from?: string, to?: string) {
  const r = businessRange(from, to);
  return { ...r, where: Prisma.sql`s.status = 'APPROVED' AND s.created_at >= ${r.gte} AND s.created_at < ${r.lt}` };
}

export async function salesSummary(from?: string, to?: string) {
  const r = range(from, to);

  const [totals] = await prisma.$queryRaw<Record<string, bigint | number | null>[]>`
    SELECT
      COUNT(*)                                                  AS "tickets",
      COUNT(*) FILTER (WHERE NOT s.is_courtesy)                 AS "paidTickets",
      COALESCE(SUM(s.total), 0)                                 AS "revenue",
      COALESCE(SUM(s.ingredient_cost) FILTER (WHERE NOT s.is_courtesy), 0) AS "costOfGoodsSold",
      COALESCE(SUM(s.gross_margin)    FILTER (WHERE NOT s.is_courtesy), 0) AS "grossMargin",
      COALESCE(ROUND(AVG(s.total) FILTER (WHERE NOT s.is_courtesy)), 0)    AS "averageTicket",
      COUNT(*) FILTER (WHERE s.is_courtesy)                     AS "courtesyTickets",
      COALESCE(SUM(s.subtotal)        FILTER (WHERE s.is_courtesy), 0)     AS "courtesyRetailValue",
      COALESCE(SUM(s.ingredient_cost) FILTER (WHERE s.is_courtesy), 0)     AS "courtesyCost"
    FROM sales s
    WHERE ${r.where}`;

  const byMethod = await prisma.$queryRaw`
    SELECT p.method::text AS "method", COUNT(*) AS "payments", COALESCE(SUM(p.amount), 0) AS "amount"
    FROM sale_payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE ${r.where}
    GROUP BY p.method
    ORDER BY "amount" DESC`;

  const refunds = await prisma.$queryRaw`
    SELECT COUNT(*) AS "count", COALESCE(SUM(total), 0) AS "amount"
    FROM sales
    WHERE status = 'REFUNDED' AND created_at >= ${r.gte} AND created_at < ${r.lt}`;

  const daily = await prisma.$queryRaw`
    SELECT to_char(s.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS "date",
           COUNT(*) AS "tickets",
           COALESCE(SUM(s.total), 0) AS "revenue",
           COALESCE(SUM(s.gross_margin) FILTER (WHERE NOT s.is_courtesy), 0) AS "grossMargin"
    FROM sales s
    WHERE ${r.where}
    GROUP BY 1
    ORDER BY 1`;

  const t = toPlain(totals ?? {}) as Record<string, number>;
  const revenue = t.revenue ?? 0;
  return {
    from: r.from,
    to: r.to,
    ...t,
    grossMarginPct: revenue > 0 ? Math.round(((t.grossMargin ?? 0) / revenue) * 1000) / 10 : 0,
    byPaymentMethod: toPlain(byMethod),
    refunds: toPlain((refunds as unknown[])[0]),
    daily: toPlain(daily),
  };
}

export async function topProducts(from?: string, to?: string, limit = 20) {
  const r = range(from, to);
  const rows = await prisma.$queryRaw`
    SELECT i.product_id AS "productId",
           MAX(i.product_name) AS "productName",
           SUM(i.quantity) AS "unitsSold",
           SUM(i.subtotal) FILTER (WHERE NOT s.is_courtesy) AS "revenue",
           SUM(i.ingredient_cost) AS "ingredientCost",
           SUM(i.quantity) FILTER (WHERE s.is_courtesy) AS "courtesyUnits"
    FROM sale_items i
    JOIN sales s ON s.id = i.sale_id
    WHERE ${r.where}
    GROUP BY i.product_id
    ORDER BY "unitsSold" DESC
    LIMIT ${limit}`;
  return { from: r.from, to: r.to, products: toPlain(rows) };
}

export async function salesBySeller(from?: string, to?: string) {
  const r = range(from, to);
  const rows = await prisma.$queryRaw`
    SELECT s.seller_id AS "sellerId",
           MAX(s.seller_name) AS "sellerName",
           COUNT(*) FILTER (WHERE NOT s.is_courtesy) AS "tickets",
           COALESCE(SUM(s.total), 0) AS "revenue",
           COALESCE(ROUND(AVG(s.total) FILTER (WHERE NOT s.is_courtesy)), 0) AS "averageTicket",
           COUNT(*) FILTER (WHERE s.is_courtesy) AS "courtesiesGiven"
    FROM sales s
    WHERE ${r.where}
    GROUP BY s.seller_id
    ORDER BY "revenue" DESC`;
  return { from: r.from, to: r.to, sellers: toPlain(rows) };
}

/** Tracking de cortesías: quién consume, cuánto vale y cuánto le cuesta al negocio. */
export async function courtesies(from?: string, to?: string) {
  const r = range(from, to);
  const byBeneficiary = await prisma.$queryRaw`
    SELECT s.courtesy_beneficiary AS "beneficiary",
           s.courtesy_type::text  AS "type",
           COUNT(*)               AS "tickets",
           SUM(s.subtotal)        AS "retailValue",
           SUM(s.ingredient_cost) AS "realCost"
    FROM sales s
    WHERE ${r.where} AND s.is_courtesy
    GROUP BY s.courtesy_beneficiary, s.courtesy_type
    ORDER BY "retailValue" DESC`;
  const detail = await prisma.$queryRaw`
    SELECT s.id, s.ticket_number AS "ticketNumber", s.created_at AS "createdAt",
           s.courtesy_beneficiary AS "beneficiary", s.courtesy_type::text AS "type",
           s.courtesy_notes AS "notes", s.seller_name AS "sellerName",
           s.subtotal AS "retailValue", s.ingredient_cost AS "realCost"
    FROM sales s
    WHERE ${r.where} AND s.is_courtesy
    ORDER BY s.created_at DESC
    LIMIT 500`;
  return { from: r.from, to: r.to, byBeneficiary: toPlain(byBeneficiary), detail: toPlain(detail) };
}

export async function salesByHour(from?: string, to?: string) {
  const r = range(from, to);
  const rows = await prisma.$queryRaw`
    SELECT EXTRACT(HOUR FROM s.created_at AT TIME ZONE ${TZ})::int AS "hour",
           COUNT(*) AS "tickets",
           COALESCE(SUM(s.total), 0) AS "revenue"
    FROM sales s
    WHERE ${r.where}
    GROUP BY 1
    ORDER BY 1`;
  return { from: r.from, to: r.to, hours: toPlain(rows) };
}

export async function inventoryValuation() {
  const rows = await prisma.$queryRaw`
    SELECT location::text AS "location",
           COUNT(*) AS "items",
           ROUND(SUM(GREATEST(current_stock, 0) * unit_cost)) AS "value",
           COUNT(*) FILTER (WHERE current_stock <= minimum_stock) AS "lowStockItems"
    FROM inventory_items
    WHERE is_active
    GROUP BY location`;
  return toPlain(rows);
}

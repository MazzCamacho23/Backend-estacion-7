import crypto from 'node:crypto';
import {
  CourtesyType,
  InventoryLocation,
  MovementType,
  OpenTableStatus,
  PaymentMethod,
  Prisma,
  type Role,
  SaleMode,
  SaleStatus,
} from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { businessRange } from '../../lib/time';
import type { AuthUser } from '../../lib/tokens';
import { paginate } from '../../lib/validation';
import { RealtimeEvents, Rooms } from '../../realtime/events';
import { publish } from '../../realtime/socket';
import { applyStockChanges, publishInventoryChanges } from '../inventory/inventory.ledger';
import { shiftView } from '../shifts/shifts.service';
import { computeConsumption, lineInputSchema, parseModifiers, type PricedLine, priceLines } from './pricing';

// ----------------------------------------------------------------------------
//  Validación de entrada
// ----------------------------------------------------------------------------

const paymentSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  amount: z.number().int().min(0),
  reference: z.string().trim().max(80).nullish(),
  receivedAmount: z.number().int().min(0).nullish(),
});

export const checkoutSchema = z
  .object({
    /** UUID generado en el celular ANTES de enviar. Reintentos usan el mismo. */
    clientRequestId: z.string().min(8).max(64),
    openTableId: z.string().uuid().optional(),
    items: z.array(lineInputSchema).max(200).optional(),
    tableLabel: z.string().trim().max(60).nullish(),
    payments: z.array(paymentSchema).max(5).default([]),
    courtesy: z
      .object({
        beneficiary: z.string().trim().min(2).max(120),
        type: z.nativeEnum(CourtesyType),
        notes: z.string().trim().max(500).nullish(),
      })
      .nullish(),
  })
  .superRefine((d, ctx) => {
    if (!!d.openTableId === !!d.items?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Envía openTableId (cobrar mesa) o items (venta directa), uno de los dos',
      });
    }
    if (!d.courtesy && d.payments.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payments'], message: 'Indica al menos un pago' });
    }
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ----------------------------------------------------------------------------
//  Presentación
// ----------------------------------------------------------------------------

const saleInclude = {
  items: true,
  payments: true,
} satisfies Prisma.SaleInclude;

type SaleFull = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

/** Los vendedores no ven costos ni márgenes. */
export function presentSale(sale: SaleFull, role: Role) {
  const base = { ...sale, ticketId: String(sale.ticketNumber) };
  if (role === 'OWNER') return base;
  const { ingredientCost: _c, grossMargin: _m, ...rest } = base;
  return { ...rest, items: sale.items.map(({ ingredientCost: _ic, ...i }) => i) };
}

// ----------------------------------------------------------------------------
//  Checkout
// ----------------------------------------------------------------------------

function buildPayments(input: CheckoutInput, total: number): Prisma.SalePaymentCreateWithoutSaleInput[] {
  if (input.courtesy) return [{ method: PaymentMethod.COURTESY, amount: 0 }];

  if (input.payments.some((p) => p.method === PaymentMethod.COURTESY)) {
    throw badRequest('Para registrar una cortesía envía el objeto "courtesy"', 'COURTESY_DATA_REQUIRED');
  }
  const paid = input.payments.reduce((acc, p) => acc + p.amount, 0);
  if (paid !== total) {
    throw badRequest(`La suma de los pagos ($${paid}) no coincide con el total ($${total})`, 'PAYMENT_MISMATCH', {
      total,
      paid,
    });
  }

  return input.payments.map((p) => {
    if (p.method === PaymentMethod.CASH) {
      const received = p.receivedAmount ?? p.amount;
      if (received < p.amount) {
        throw badRequest('El efectivo recibido es menor al valor a pagar', 'INSUFFICIENT_CASH', {
          amount: p.amount,
          received,
        });
      }
      return { method: p.method, amount: p.amount, receivedAmount: received, changeAmount: received - p.amount };
    }
    return { method: p.method, amount: p.amount, reference: p.reference ?? null };
  });
}

type SaleLine = PricedLine & { saleMode: SaleMode; tableLabel: string | null };

export async function checkout(input: CheckoutInput, user: AuthUser) {
  // 1) Idempotencia: si ya se procesó esta petición, se devuelve la misma venta.
  const replay = await findReplay(input.clientRequestId, user);
  if (replay) return replay;

  let result;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // 2) Turno abierto. FOR SHARE impide que el turno se cierre a mitad de la venta.
        const [shift] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM seller_shifts
          WHERE seller_id = ${user.id}::uuid AND closed_at IS NULL
          ORDER BY opened_at DESC LIMIT 1
          FOR SHARE`;
        if (!shift && user.role === 'EMPLOYEE') {
          throw conflict('Debes abrir tu turno antes de vender', 'SHIFT_NOT_OPEN');
        }

        // 3) Líneas: desde la mesa (precios congelados) o venta directa (precios actuales).
        let lines: SaleLine[];
        let tableLabel = input.tableLabel ?? null;
        let closedTable: { id: string; label: string; version: number } | null = null;

        if (input.openTableId) {
          // Reclamar la mesa de forma atómica: si dos vendedores cobran la misma
          // mesa al tiempo, solo uno lo logra.
          const claimed = await tx.openTable.updateMany({
            where: { id: input.openTableId, status: OpenTableStatus.OPEN },
            data: {
              status: OpenTableStatus.CLOSED,
              activeLabelKey: null,
              closedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (!claimed.count) {
            const exists = await tx.openTable.findUnique({ where: { id: input.openTableId } });
            if (!exists) throw notFound('Mesa no encontrada');
            throw conflict(`La mesa "${exists.label}" ya fue cobrada o eliminada`, 'TABLE_NOT_OPEN');
          }
          const table = await tx.openTable.findUniqueOrThrow({
            where: { id: input.openTableId },
            include: { items: { orderBy: { createdAt: 'asc' } } },
          });
          if (!table.items.length) throw badRequest('La mesa no tiene productos', 'TABLE_EMPTY');

          tableLabel = table.label;
          closedTable = { id: table.id, label: table.label, version: table.version };
          lines = table.items.map((i) => ({
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            subtotal: i.subtotal,
            modifiers: parseModifiers(i.modifiers),
            observations: i.observations,
            saleMode: SaleMode.TABLE_GROUP,
            tableLabel: table.label,
          }));
        } else {
          const priced = await priceLines(tx, input.items!);
          lines = priced.map((l) => ({ ...l, saleMode: SaleMode.INDIVIDUAL, tableLabel }));
        }

        // 4) Totales y pagos. Cortesía = se cobra $0 pero SÍ descuenta inventario.
        const subtotal = lines.reduce((acc, l) => acc + l.subtotal, 0);
        const isCourtesy = !!input.courtesy;
        const total = isCourtesy ? 0 : subtotal;
        const payments = buildPayments(input, total);

        // 5) Costo real según recetas.
        const { lineCosts, totals } = await computeConsumption(tx, lines);
        const ingredientCost = lineCosts.reduce((a, b) => a + b, 0);

        // 6) Crear la venta.
        const saleId = crypto.randomUUID();
        const created = await tx.sale.create({
          data: {
            id: saleId,
            clientRequestId: input.clientRequestId,
            subtotal,
            total,
            status: SaleStatus.APPROVED,
            sellerId: user.id,
            sellerName: user.name,
            shiftId: shift?.id ?? null,
            openTableId: closedTable?.id ?? null,
            tableLabel,
            ingredientCost,
            grossMargin: total - ingredientCost,
            isCourtesy,
            courtesyBeneficiary: input.courtesy?.beneficiary ?? null,
            courtesyType: input.courtesy?.type ?? null,
            courtesyNotes: input.courtesy?.notes ?? null,
            items: {
              create: lines.map((l, idx) => ({
                productId: l.productId,
                productName: l.productName,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                subtotal: l.subtotal,
                modifiers: l.modifiers as unknown as Prisma.InputJsonValue,
                observations: l.observations,
                saleMode: l.saleMode,
                tableLabel: l.tableLabel,
                ingredientCost: lineCosts[idx] ?? 0,
              })),
            },
            payments: { create: payments },
          },
        });

        // 7) Descontar inventario del punto de venta (con auditoría).
        const reason = `${isCourtesy ? 'Cortesía' : 'Venta'} ticket #${created.ticketNumber}`;
        const inventoryItems = await applyStockChanges(
          tx,
          [...totals].map(([itemId, qty]) => ({
            itemId,
            delta: qty.neg(),
            type: MovementType.SALE_CONSUMPTION,
            origin: InventoryLocation.POINT_OF_SALE,
            reason,
            saleId,
          })),
          user,
          { allowNegative: env.ALLOW_NEGATIVE_STOCK },
        );

        const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
        return { sale, inventoryItems, closedTable, shiftId: shift?.id ?? null };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  } catch (e) {
    // Dos reintentos simultáneos con el mismo clientRequestId: el segundo choca con el UNIQUE.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await findReplay(input.clientRequestId, user);
      if (again) return again;
    }
    throw e;
  }

  // 8) Notificar a todos los dispositivos (después del commit).
  publishSale(RealtimeEvents.SALE_CREATED, result.sale);
  publishInventoryChanges(result.inventoryItems);
  if (result.closedTable) {
    publish(RealtimeEvents.TABLE_CLOSED, {
      id: result.closedTable.id,
      label: result.closedTable.label,
      status: OpenTableStatus.CLOSED,
      version: result.closedTable.version,
      saleId: result.sale.id,
    });
  }
  if (result.shiftId) void publishShiftById(result.shiftId);

  logger.info(
    { saleId: result.sale.id, ticket: result.sale.ticketNumber, total: result.sale.total, seller: user.name },
    'Venta registrada',
  );
  return { sale: presentSale(result.sale, user.role), replayed: false };
}

async function findReplay(clientRequestId: string, user: AuthUser) {
  const existing = await prisma.sale.findUnique({ where: { clientRequestId }, include: saleInclude });
  if (!existing) return null;
  if (existing.sellerId !== user.id) {
    throw conflict('Ese clientRequestId ya fue usado por otra venta', 'IDEMPOTENCY_KEY_REUSED');
  }
  return { sale: presentSale(existing, user.role), replayed: true };
}

function publishSale(event: typeof RealtimeEvents.SALE_CREATED | typeof RealtimeEvents.SALE_REFUNDED, sale: SaleFull) {
  publish(event, presentSale(sale, 'OWNER'), { room: Rooms.OWNERS });
  publish(event, presentSale(sale, 'EMPLOYEE'), { room: Rooms.STAFF, except: Rooms.OWNERS });
}

async function publishShiftById(shiftId: string) {
  try {
    const shift = await prisma.sellerShift.findUnique({ where: { id: shiftId } });
    if (!shift) return;
    const view = await shiftView(shift);
    publish(RealtimeEvents.SHIFT_UPDATED, view, { room: Rooms.OWNERS });
    publish(RealtimeEvents.SHIFT_UPDATED, view, { room: Rooms.user(shift.sellerId), except: Rooms.OWNERS });
  } catch (err) {
    logger.warn({ err, shiftId }, 'No se pudo publicar el turno');
  }
}

// ----------------------------------------------------------------------------
//  Anulación (reembolso)
// ----------------------------------------------------------------------------

export async function refundSale(id: string, input: { reason: string; restock: boolean }, user: AuthUser) {
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.sale.updateMany({
      where: { id, status: SaleStatus.APPROVED },
      data: { status: SaleStatus.REFUNDED, refundedAt: new Date(), refundedById: user.id, refundReason: input.reason },
    });
    if (!count) {
      const exists = await tx.sale.findUnique({ where: { id }, select: { status: true } });
      if (!exists) throw notFound('Venta no encontrada');
      throw conflict(`Solo se pueden anular ventas aprobadas (estado actual: ${exists.status})`, 'SALE_NOT_REFUNDABLE');
    }

    // Reintegrar inventario solo si el producto no se alcanzó a preparar.
    let inventoryItems: Awaited<ReturnType<typeof applyStockChanges>> = [];
    if (input.restock) {
      const consumed = await tx.inventoryMovement.findMany({
        where: { saleId: id, type: MovementType.SALE_CONSUMPTION },
      });
      inventoryItems = await applyStockChanges(
        tx,
        consumed.map((m) => ({
          itemId: m.inventoryItemId,
          delta: m.quantity.neg(),
          type: MovementType.SALE_REVERSAL,
          destination: InventoryLocation.POINT_OF_SALE,
          reason: `Anulación: ${input.reason}`,
          saleId: id,
          unitCost: m.unitCost,
        })),
        user,
        { allowNegative: true },
      );
    }
    const sale = await tx.sale.findUniqueOrThrow({ where: { id }, include: saleInclude });
    return { sale, inventoryItems };
  });

  publishSale(RealtimeEvents.SALE_REFUNDED, result.sale);
  publishInventoryChanges(result.inventoryItems);
  if (result.sale.shiftId) void publishShiftById(result.sale.shiftId);
  return presentSale(result.sale, user.role);
}

// ----------------------------------------------------------------------------
//  Consultas
// ----------------------------------------------------------------------------

export async function listSales(
  filter: {
    from?: string;
    to?: string;
    sellerId?: string;
    shiftId?: string;
    status?: SaleStatus;
    isCourtesy?: boolean;
    page: number;
    pageSize: number;
  },
  user: AuthUser,
) {
  const range = businessRange(filter.from, filter.to);
  const where: Prisma.SaleWhereInput = {
    createdAt: { gte: range.gte, lt: range.lt },
    sellerId: user.role === 'OWNER' ? filter.sellerId : user.id,
    shiftId: filter.shiftId,
    status: filter.status,
    isCourtesy: filter.isCourtesy,
  };
  const [rows, total] = await prisma.$transaction([
    prisma.sale.findMany({
      where,
      include: saleInclude,
      orderBy: { createdAt: 'desc' },
      ...paginate(filter.page, filter.pageSize),
    }),
    prisma.sale.count({ where }),
  ]);
  return {
    data: rows.map((s) => presentSale(s, user.role)),
    page: filter.page,
    pageSize: filter.pageSize,
    total,
  };
}

export async function getSale(idOrTicket: string, user: AuthUser) {
  const where: Prisma.SaleWhereUniqueInput = /^\d+$/.test(idOrTicket)
    ? { ticketNumber: Number(idOrTicket) }
    : { id: idOrTicket };
  const sale = await prisma.sale.findUnique({ where, include: saleInclude });
  if (!sale) throw notFound('Venta no encontrada');
  if (user.role !== 'OWNER' && sale.sellerId !== user.id) throw forbidden('Esta venta no es tuya');
  return presentSale(sale, user.role);
}

import { PaymentMethod, Prisma, SaleStatus, type SellerShift } from '@prisma/client';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { prisma, type Tx } from '../../lib/prisma';
import { businessDateKey } from '../../lib/time';
import type { AuthUser } from '../../lib/tokens';
import { RealtimeEvents, Rooms } from '../../realtime/events';
import { publish } from '../../realtime/socket';

type Db = Tx | typeof prisma;

export interface ShiftTotals {
  totalSalesCollected: number;
  totalTickets: number;
  courtesyTickets: number;
  byMethod: Record<'CASH' | 'TRANSFER' | 'CARD_TERMINAL', number>;
  cashCollected: number;
}

/** Totales calculados desde las ventas APROBADAS del turno (las anuladas no cuentan). */
export async function computeShiftTotals(db: Db, shiftId: string): Promise<ShiftTotals> {
  const approved = { shiftId, status: SaleStatus.APPROVED };
  const agg = await db.sale.aggregate({ where: approved, _sum: { total: true }, _count: { _all: true } });
  const courtesyTickets = await db.sale.count({ where: { ...approved, isCourtesy: true } });
  const byMethodRows = await db.salePayment.groupBy({
    by: ['method'],
    where: { sale: approved },
    _sum: { amount: true },
  });

  const byMethod = { CASH: 0, TRANSFER: 0, CARD_TERMINAL: 0 };
  for (const row of byMethodRows) {
    if (row.method !== PaymentMethod.COURTESY) byMethod[row.method] = row._sum.amount ?? 0;
  }
  return {
    totalSalesCollected: agg._sum.total ?? 0,
    totalTickets: agg._count._all,
    courtesyTickets,
    byMethod,
    cashCollected: byMethod.CASH,
  };
}

export async function shiftView(shift: SellerShift) {
  const totals = await computeShiftTotals(prisma, shift.id);
  return {
    ...shift,
    isOpen: shift.closedAt === null,
    // Mientras está abierto, todo es en vivo. Al cerrar, quedan congelados en las columnas.
    live: { ...totals, expectedCash: shift.startingCash + totals.cashCollected },
  };
}

async function publishShift(shift: SellerShift) {
  const view = await shiftView(shift);
  publish(RealtimeEvents.SHIFT_UPDATED, view, { room: Rooms.OWNERS });
  publish(RealtimeEvents.SHIFT_UPDATED, view, { room: Rooms.user(shift.sellerId), except: Rooms.OWNERS });
  return view;
}

export function findOpenShift(db: Db, sellerId: string) {
  return db.sellerShift.findFirst({ where: { sellerId, closedAt: null }, orderBy: { openedAt: 'desc' } });
}

export async function openShift(user: AuthUser, startingCash: number) {
  const dateKey = businessDateKey();
  const open = await findOpenShift(prisma, user.id);
  if (open) {
    if (open.dateKey === dateKey) throw conflict('Ya tienes un turno abierto hoy', 'SHIFT_ALREADY_OPEN', { shiftId: open.id });
    throw conflict(
      `Tienes abierto el turno del ${open.dateKey}. Ciérralo antes de abrir uno nuevo`,
      'PREVIOUS_SHIFT_OPEN',
      { shiftId: open.id },
    );
  }

  try {
    const shift = await prisma.sellerShift.create({
      data: { sellerId: user.id, sellerName: user.name, dateKey, startingCash },
    });
    return publishShift(shift);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict(
        'Tu turno de hoy ya fue cerrado. Pide a un administrador que lo reabra',
        'SHIFT_ALREADY_CLOSED_TODAY',
      );
    }
    throw e;
  }
}

export async function getCurrentShift(user: AuthUser) {
  const shift = await findOpenShift(prisma, user.id);
  return { shift: shift ? await shiftView(shift) : null };
}

async function getShiftForUser(id: string, user: AuthUser) {
  const shift = await prisma.sellerShift.findUnique({ where: { id } });
  if (!shift) throw notFound('Turno no encontrado');
  if (user.role !== 'OWNER' && shift.sellerId !== user.id) throw forbidden('Este turno no es tuyo');
  return shift;
}

export async function getShift(id: string, user: AuthUser) {
  return shiftView(await getShiftForUser(id, user));
}

/**
 * Resumen para el cierre de caja (y para "Ventas de hoy" del vendedor): todas las
 * ventas del turno con sus pagos, totales por método, efectivo esperado,
 * cortesías, anulaciones y productos vendidos. Los vendedores no reciben costos.
 */
export async function getShiftSummary(shift: SellerShift, user: AuthUser) {
  const isOwner = user.role === 'OWNER';
  const view = await shiftView(shift);
  const sales = await prisma.sale.findMany({
    where: { shiftId: shift.id },
    include: { items: true, payments: true },
    orderBy: { createdAt: 'desc' },
  });

  const approved = sales.filter((s) => s.status === SaleStatus.APPROVED);
  const refunded = sales.filter((s) => s.status === SaleStatus.REFUNDED);
  const courtesies = approved.filter((s) => s.isCourtesy);
  const cashPayments = approved.flatMap((s) => s.payments).filter((p) => p.method === PaymentMethod.CASH);

  const products = new Map<string, { productId: string; productName: string; units: number; revenue: number; courtesyUnits: number }>();
  for (const s of approved) {
    for (const i of s.items) {
      const p = products.get(i.productId) ?? { productId: i.productId, productName: i.productName, units: 0, revenue: 0, courtesyUnits: 0 };
      p.units += i.quantity;
      if (s.isCourtesy) p.courtesyUnits += i.quantity;
      else p.revenue += i.subtotal;
      products.set(i.productId, p);
    }
  }

  return {
    shift: view,
    totals: {
      tickets: approved.length,
      paidTickets: approved.length - courtesies.length,
      collected: view.live.totalSalesCollected,
      byMethod: view.live.byMethod,
      unitsSold: approved.reduce((a, s) => a + s.items.reduce((b, i) => b + i.quantity, 0), 0),
      averageTicket: approved.length - courtesies.length ? Math.round(view.live.totalSalesCollected / (approved.length - courtesies.length)) : 0,
    },
    cash: {
      startingCash: shift.startingCash,
      cashSales: view.live.cashCollected,
      receivedFromCustomers: cashPayments.reduce((a, p) => a + (p.receivedAmount ?? p.amount), 0),
      changeGiven: cashPayments.reduce((a, p) => a + (p.changeAmount ?? 0), 0),
      expectedCash: view.live.expectedCash,
    },
    courtesies: {
      count: courtesies.length,
      retailValue: courtesies.reduce((a, s) => a + s.subtotal, 0),
      ...(isOwner ? { cost: courtesies.reduce((a, s) => a + s.ingredientCost, 0) } : {}),
    },
    refunds: {
      count: refunded.length,
      amount: refunded.reduce((a, s) => a + s.total, 0),
    },
    ...(isOwner
      ? {
          profit: {
            ingredientCost: approved.reduce((a, s) => a + s.ingredientCost, 0),
            grossMargin: approved.reduce((a, s) => a + s.grossMargin, 0),
          },
        }
      : {}),
    products: [...products.values()].sort((a, b) => b.units - a.units || b.revenue - a.revenue),
    sales: sales.map((s) => ({
      id: s.id,
      ticketNumber: s.ticketNumber,
      createdAt: s.createdAt,
      status: s.status,
      subtotal: s.subtotal,
      total: s.total,
      isCourtesy: s.isCourtesy,
      courtesyBeneficiary: s.courtesyBeneficiary,
      courtesyType: s.courtesyType,
      tableLabel: s.tableLabel,
      refundReason: s.refundReason,
      payments: s.payments.map((p) => ({
        method: p.method, amount: p.amount, reference: p.reference, receivedAmount: p.receivedAmount, changeAmount: p.changeAmount,
      })),
      items: s.items.map((i) => ({
        productId: i.productId, productName: i.productName, quantity: i.quantity, unitPrice: i.unitPrice, subtotal: i.subtotal,
        modifiers: i.modifiers, observations: i.observations,
      })),
      ...(isOwner ? { ingredientCost: s.ingredientCost, grossMargin: s.grossMargin } : {}),
    })),
  };
}

export async function getCurrentShiftSummary(user: AuthUser) {
  const shift = await findOpenShift(prisma, user.id);
  return shift ? getShiftSummary(shift, user) : { shift: null };
}

export async function getShiftSummaryById(id: string, user: AuthUser) {
  return getShiftSummary(await getShiftForUser(id, user), user);
}

/** Cierre de caja: congela totales y calcula faltante/sobrante. */
export async function closeShift(id: string, input: { countedCash: number; notes?: string | null }, user: AuthUser) {
  await getShiftForUser(id, user);

  const closed = await prisma.$transaction(async (tx) => {
    // Al marcar closed_at primero, el UPDATE bloquea la fila: las ventas en curso
    // (que toman FOR SHARE sobre el turno) terminan antes, y las nuevas ya lo ven cerrado.
    const { count } = await tx.sellerShift.updateMany({
      where: { id, closedAt: null },
      data: { closedAt: new Date() },
    });
    if (!count) throw conflict('Este turno ya está cerrado', 'SHIFT_ALREADY_CLOSED');

    const shift = await tx.sellerShift.findUniqueOrThrow({ where: { id } });
    const totals = await computeShiftTotals(tx, id);
    const expectedCash = shift.startingCash + totals.cashCollected;
    return tx.sellerShift.update({
      where: { id },
      data: {
        totalSalesCollected: totals.totalSalesCollected,
        totalTickets: totals.totalTickets,
        cashCollected: totals.cashCollected,
        expectedCash,
        countedCash: input.countedCash,
        cashDifference: input.countedCash - expectedCash,
        closingNotes: input.notes ?? null,
      },
    });
  });

  return publishShift(closed);
}

/** Solo OWNER: reabre un turno cerrado por error. */
export async function reopenShift(id: string) {
  const shift = await prisma.sellerShift.findUnique({ where: { id } });
  if (!shift) throw notFound('Turno no encontrado');
  if (!shift.closedAt) throw conflict('El turno ya está abierto', 'SHIFT_ALREADY_OPEN');
  const other = await findOpenShift(prisma, shift.sellerId);
  if (other) throw conflict('El vendedor tiene otro turno abierto', 'PREVIOUS_SHIFT_OPEN', { shiftId: other.id });

  const reopened = await prisma.sellerShift.update({
    where: { id },
    data: {
      closedAt: null,
      cashCollected: null,
      expectedCash: null,
      countedCash: null,
      cashDifference: null,
      closingNotes: null,
    },
  });
  return publishShift(reopened);
}

export async function listShifts(
  filter: { from?: string; to?: string; sellerId?: string; open?: boolean },
  user: AuthUser,
) {
  const shifts = await prisma.sellerShift.findMany({
    where: {
      sellerId: user.role === 'OWNER' ? filter.sellerId : user.id,
      dateKey: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
      closedAt: filter.open === undefined ? undefined : filter.open ? null : { not: null },
    },
    orderBy: [{ dateKey: 'desc' }, { openedAt: 'desc' }],
    take: 200,
  });
  return Promise.all(shifts.map(shiftView));
}

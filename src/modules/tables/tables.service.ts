import { OpenTableStatus, Prisma } from '@prisma/client';
import { conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AuthUser } from '../../lib/tokens';
import { RealtimeEvents } from '../../realtime/events';
import { publish } from '../../realtime/socket';
import { type LineInput, type PricedLine, priceLines } from '../sales/pricing';

const includeItems = { items: { orderBy: { createdAt: 'asc' } } } as const satisfies Prisma.OpenTableInclude;

export const labelKey = (label: string) => label.trim().toLowerCase().replace(/\s+/g, ' ');

function withTotal<T extends { items: { subtotal: number }[] }>(t: T) {
  return { ...t, total: t.items.reduce((acc, i) => acc + i.subtotal, 0) };
}

async function loadTable(id: string) {
  const table = await prisma.openTable.findUnique({ where: { id }, include: includeItems });
  if (!table) throw notFound('Mesa no encontrada');
  return withTotal(table);
}

async function loadOpenTableOrFail(id: string) {
  const table = await prisma.openTable.findUnique({ where: { id }, select: { id: true, status: true, label: true } });
  if (!table) throw notFound('Mesa no encontrada');
  if (table.status !== OpenTableStatus.OPEN) {
    throw conflict(`La mesa "${table.label}" ya fue cerrada o eliminada`, 'TABLE_NOT_OPEN');
  }
  return table;
}

/** Sube la versión y publica el estado completo de la mesa. */
async function touchAndPublish(id: string) {
  await prisma.openTable.update({ where: { id }, data: { version: { increment: 1 } } });
  const table = await loadTable(id);
  publish(RealtimeEvents.TABLE_UPSERTED, table);
  return table;
}

export async function listOpenTables(updatedSince?: Date) {
  const tables = await prisma.openTable.findMany({
    where: updatedSince ? { updatedAt: { gt: updatedSince } } : { status: OpenTableStatus.OPEN },
    include: includeItems,
    orderBy: { createdAt: 'asc' },
  });
  return tables.map(withTotal);
}

export const getTable = loadTable;

function toItemData(p: PricedLine, user: AuthUser) {
  return {
    productId: p.productId,
    productName: p.productName,
    quantity: p.quantity,
    unitPrice: p.unitPrice,
    subtotal: p.subtotal,
    modifiers: p.modifiers as unknown as Prisma.InputJsonValue,
    observations: p.observations,
    sellerId: user.id,
    sellerName: user.name,
  };
}

export async function openTable(
  input: { label: string; notes?: string | null; items?: LineInput[] },
  user: AuthUser,
) {
  // Primero se validan los productos: si alguno falla, la mesa no se crea.
  const priced = input.items?.length ? await priceLines(prisma, input.items) : [];
  try {
    const t = await prisma.openTable.create({
      data: {
        label: input.label.trim(),
        activeLabelKey: labelKey(input.label),
        notes: input.notes ?? null,
        openedById: user.id,
        openedByName: user.name,
        items: { create: priced.map((p) => toItemData(p, user)) },
      },
      include: includeItems,
    });
    const table = withTotal(t);
    publish(RealtimeEvents.TABLE_UPSERTED, table);
    return table;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict(`Ya hay una mesa abierta llamada "${input.label}"`, 'TABLE_LABEL_IN_USE');
    }
    throw e;
  }
}

export async function updateTable(id: string, input: { label?: string; notes?: string | null }) {
  await loadOpenTableOrFail(id);
  try {
    await prisma.openTable.update({
      where: { id },
      data: {
        label: input.label?.trim(),
        activeLabelKey: input.label ? labelKey(input.label) : undefined,
        notes: input.notes,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict(`Ya hay una mesa abierta llamada "${input.label}"`, 'TABLE_LABEL_IN_USE');
    }
    throw e;
  }
  return touchAndPublish(id);
}

export async function addItems(id: string, lines: LineInput[], user: AuthUser) {
  await loadOpenTableOrFail(id);
  const priced = await priceLines(prisma, lines);
  await prisma.openTableItem.createMany({
    data: priced.map((p) => ({ openTableId: id, ...toItemData(p, user) })),
  });
  return touchAndPublish(id);
}

export async function updateItem(
  tableId: string,
  itemId: string,
  input: { quantity?: number; observations?: string | null },
) {
  await loadOpenTableOrFail(tableId);
  const item = await prisma.openTableItem.findFirst({ where: { id: itemId, openTableId: tableId } });
  if (!item) throw notFound('Producto no encontrado en esta mesa');
  const quantity = input.quantity ?? item.quantity;
  await prisma.openTableItem.update({
    where: { id: itemId },
    data: { quantity, subtotal: item.unitPrice * quantity, observations: input.observations },
  });
  return touchAndPublish(tableId);
}

export async function removeItem(tableId: string, itemId: string) {
  await loadOpenTableOrFail(tableId);
  const { count } = await prisma.openTableItem.deleteMany({ where: { id: itemId, openTableId: tableId } });
  if (!count) throw notFound('Producto no encontrado en esta mesa');
  return touchAndPublish(tableId);
}

/** Elimina la mesa sin cobrar (no descuenta inventario). */
export async function cancelTable(id: string) {
  const { count } = await prisma.openTable.updateMany({
    where: { id, status: OpenTableStatus.OPEN },
    data: { status: OpenTableStatus.CANCELLED, activeLabelKey: null, closedAt: new Date(), version: { increment: 1 } },
  });
  if (!count) await loadOpenTableOrFail(id); // lanza 404 o TABLE_NOT_OPEN
  const table = await loadTable(id);
  publish(RealtimeEvents.TABLE_CLOSED, { id, label: table.label, status: table.status, version: table.version });
  return table;
}

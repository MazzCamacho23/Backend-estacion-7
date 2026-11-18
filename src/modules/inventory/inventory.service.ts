import crypto from 'node:crypto';
import {
  InventoryItemType,
  InventoryLocation,
  MovementType,
  Prisma,
} from '@prisma/client';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { businessRange } from '../../lib/time';
import type { AuthUser } from '../../lib/tokens';
import { paginate } from '../../lib/validation';
import { applyStockChanges, lockItems, publishInventoryChanges } from './inventory.ledger';

const D = (n: number | string) => new Prisma.Decimal(n);

// ----------------------------------------------------------------------------
//  Insumos
// ----------------------------------------------------------------------------

export async function listItems(filter: {
  location?: InventoryLocation;
  active?: boolean;
  lowStock?: boolean;
  updatedSince?: Date;
}) {
  return prisma.inventoryItem.findMany({
    where: {
      location: filter.location,
      isActive: filter.active,
      updatedAt: filter.updatedSince ? { gt: filter.updatedSince } : undefined,
      // Comparación columna vs columna: current_stock <= minimum_stock
      currentStock: filter.lowStock ? { lte: prisma.inventoryItem.fields.minimumStock } : undefined,
    },
    orderBy: [{ location: 'asc' }, { name: 'asc' }],
  });
}

export async function getItem(id: string) {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw notFound('Insumo no encontrado');
  return item;
}

export interface CreateItemInput {
  id?: string;
  baseKey: string;
  name: string;
  type: InventoryItemType;
  location: InventoryLocation;
  minimumStock: number;
  unit: string;
  unitCost: number;
  supplier?: string | null;
  initialStock: number;
}

export async function createItem(input: CreateItemInput, actor: AuthUser) {
  const prefix = input.location === InventoryLocation.POINT_OF_SALE ? 'pos' : 'wh';
  const id = input.id ?? `${prefix}_${input.baseKey}`;

  const { item, updated } = await prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.create({
      data: {
        id,
        baseKey: input.baseKey,
        name: input.name,
        type: input.type,
        location: input.location,
        minimumStock: D(input.minimumStock),
        unit: input.unit,
        unitCost: D(input.unitCost),
        supplier: input.supplier ?? null,
      },
    });
    const updated = await applyStockChanges(
      tx,
      [
        {
          itemId: item.id,
          delta: D(input.initialStock),
          type: MovementType.INPUT,
          reason: 'Stock inicial',
          destination: item.location,
        },
      ],
      actor,
      { allowNegative: false },
    );
    return { item, updated };
  });

  const final = updated[0] ?? item;
  publishInventoryChanges([final]);
  return final;
}

export async function updateItem(
  id: string,
  data: Partial<{
    name: string;
    type: InventoryItemType;
    minimumStock: number;
    unit: string;
    unitCost: number;
    supplier: string | null;
    isActive: boolean;
  }>,
) {
  const item = await prisma.inventoryItem.update({
    where: { id },
    data: {
      ...data,
      minimumStock: data.minimumStock !== undefined ? D(data.minimumStock) : undefined,
      unitCost: data.unitCost !== undefined ? D(data.unitCost) : undefined,
    },
  });
  publishInventoryChanges([item]);
  return item;
}

// ----------------------------------------------------------------------------
//  Movimientos
// ----------------------------------------------------------------------------

/** Costo promedio ponderado al recibir mercancía nueva. */
function weightedCost(
  stock: Prisma.Decimal,
  cost: Prisma.Decimal,
  qty: Prisma.Decimal,
  newCost: Prisma.Decimal,
): Prisma.Decimal {
  if (stock.lte(0)) return newCost;
  return stock.mul(cost).add(qty.mul(newCost)).div(stock.add(qty)).toDecimalPlaces(4);
}

/** Entrada de mercancía (compra a proveedor). */
export async function registerInput(
  input: { itemId: string; quantity: number; unitCost?: number; supplier?: string; reason?: string },
  actor: AuthUser,
) {
  const qty = D(input.quantity);
  const items = await prisma.$transaction(async (tx) => {
    const [item] = await lockItems(tx, [input.itemId]);
    if (!item) throw notFound('Insumo no encontrado');

    if (input.unitCost !== undefined || input.supplier) {
      await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          unitCost:
            input.unitCost !== undefined
              ? weightedCost(item.currentStock, item.unitCost, qty, D(input.unitCost))
              : undefined,
          supplier: input.supplier ?? undefined,
        },
      });
    }

    return applyStockChanges(
      tx,
      [
        {
          itemId: item.id,
          delta: qty,
          type: MovementType.INPUT,
          reason: input.reason ?? (input.supplier ? `Compra a ${input.supplier}` : 'Entrada de mercancía'),
          destination: item.location,
          unitCost: input.unitCost !== undefined ? D(input.unitCost) : undefined,
        },
      ],
      actor,
      { allowNegative: false },
    );
  });
  publishInventoryChanges(items);
  return items[0];
}

/** Salida manual: merma, producto dañado, vencido, consumo interno... */
export async function registerOutput(input: { itemId: string; quantity: number; reason: string }, actor: AuthUser) {
  const item = await getItem(input.itemId);
  const items = await prisma.$transaction((tx) =>
    applyStockChanges(
      tx,
      [
        {
          itemId: item.id,
          delta: D(input.quantity).neg(),
          type: MovementType.OUTPUT,
          reason: input.reason,
          origin: item.location,
        },
      ],
      actor,
      { allowNegative: false },
    ),
  );
  publishInventoryChanges(items);
  return items[0];
}

/** Traslado Bodega -> Punto de venta del mismo insumo (mismo baseKey). */
export async function transferWarehouseToPos(input: { baseKey: string; quantity: number; reason?: string }, actor: AuthUser) {
  const qty = D(input.quantity);
  const groupId = crypto.randomUUID();

  const items = await prisma.$transaction(async (tx) => {
    const pair = await tx.inventoryItem.findMany({ where: { baseKey: input.baseKey } });
    const wh = pair.find((i) => i.location === InventoryLocation.WAREHOUSE);
    const pos = pair.find((i) => i.location === InventoryLocation.POINT_OF_SALE);
    if (!wh || !pos) {
      throw badRequest(
        `El insumo "${input.baseKey}" debe existir en bodega y en punto de venta para trasladarlo`,
        'TRANSFER_PAIR_MISSING',
      );
    }
    if (wh.unit !== pos.unit) throw conflict(`Unidades distintas: bodega usa ${wh.unit} y punto de venta ${pos.unit}`);

    const locked = await lockItems(tx, [wh.id, pos.id]);
    const lockedWh = locked.find((i) => i.id === wh.id);
    const lockedPos = locked.find((i) => i.id === pos.id);
    if (!lockedWh || !lockedPos) throw notFound('Insumo no encontrado');

    // El costo del punto de venta se promedia con el costo de lo que llega de bodega.
    await tx.inventoryItem.update({
      where: { id: lockedPos.id },
      data: { unitCost: weightedCost(lockedPos.currentStock, lockedPos.unitCost, qty, lockedWh.unitCost) },
    });

    const reason = input.reason ?? 'Traslado de bodega a punto de venta';
    return applyStockChanges(
      tx,
      [
        {
          itemId: lockedWh.id,
          delta: qty.neg(),
          type: MovementType.TRANSFER_WH_TO_POS,
          origin: InventoryLocation.WAREHOUSE,
          destination: InventoryLocation.POINT_OF_SALE,
          reason,
          transferGroupId: groupId,
          unitCost: lockedWh.unitCost,
        },
        {
          itemId: lockedPos.id,
          delta: qty,
          type: MovementType.TRANSFER_WH_TO_POS,
          origin: InventoryLocation.WAREHOUSE,
          destination: InventoryLocation.POINT_OF_SALE,
          reason,
          transferGroupId: groupId,
          unitCost: lockedWh.unitCost,
        },
      ],
      actor,
      { allowNegative: false },
    );
  });

  publishInventoryChanges(items);
  return { transferGroupId: groupId, items };
}

/** Ajuste por conteo físico: el usuario dice cuánto HAY realmente. */
export async function adjustToCount(input: { itemId: string; countedStock: number; reason: string }, actor: AuthUser) {
  const items = await prisma.$transaction(async (tx) => {
    const [item] = await lockItems(tx, [input.itemId]);
    if (!item) throw notFound('Insumo no encontrado');
    const delta = D(input.countedStock).sub(item.currentStock);
    if (delta.isZero()) return [item];
    return applyStockChanges(
      tx,
      [
        {
          itemId: item.id,
          delta,
          type: MovementType.MANUAL_ADJUSTMENT,
          reason: input.reason,
          destination: item.location,
        },
      ],
      actor,
      { allowNegative: false },
    );
  });
  publishInventoryChanges(items);
  return items[0];
}

export async function listMovements(filter: {
  itemId?: string;
  type?: MovementType;
  saleId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const range = filter.from || filter.to ? businessRange(filter.from, filter.to) : undefined;
  const where: Prisma.InventoryMovementWhereInput = {
    inventoryItemId: filter.itemId,
    type: filter.type,
    saleId: filter.saleId,
    createdAt: range ? { gte: range.gte, lt: range.lt } : undefined,
  };
  const [data, total] = await prisma.$transaction([
    prisma.inventoryMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...paginate(filter.page, filter.pageSize),
    }),
    prisma.inventoryMovement.count({ where }),
  ]);
  return { data, page: filter.page, pageSize: filter.pageSize, total };
}

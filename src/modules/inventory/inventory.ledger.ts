import { type InventoryItem, type InventoryLocation, type MovementType, Prisma } from '@prisma/client';
import { AppError } from '../../lib/errors';
import type { Tx } from '../../lib/prisma';
import type { AuthUser } from '../../lib/tokens';
import { RealtimeEvents, Rooms } from '../../realtime/events';
import { publish } from '../../realtime/socket';

export interface StockChange {
  itemId: string;
  /** Con signo: positivo entra, negativo sale. */
  delta: Prisma.Decimal;
  type: MovementType;
  reason?: string | null;
  origin?: InventoryLocation | null;
  destination?: InventoryLocation | null;
  saleId?: string;
  transferGroupId?: string;
  unitCost?: Prisma.Decimal;
}

/**
 * Bloquea las filas (SELECT ... FOR UPDATE) en orden alfabético de id.
 * Orden fijo = sin deadlocks cuando dos ventas tocan los mismos insumos.
 */
export async function lockItems(tx: Tx, ids: string[]): Promise<InventoryItem[]> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return [];
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`;
  const items = await tx.inventoryItem.findMany({ where: { id: { in: unique } } });
  const missing = unique.filter((id) => !items.some((i) => i.id === id));
  if (missing.length) throw new AppError(404, 'INVENTORY_ITEM_NOT_FOUND', 'Insumo no encontrado', { missing });
  return items;
}

/**
 * ÚNICO punto del sistema que modifica current_stock.
 * Actualiza el stock de forma atómica y deja el rastro en inventory_movements.
 * Debe ejecutarse dentro de una transacción.
 */
export async function applyStockChanges(
  tx: Tx,
  changes: StockChange[],
  actor: AuthUser | null,
  opts: { allowNegative: boolean },
): Promise<InventoryItem[]> {
  const relevant = changes.filter((c) => !c.delta.isZero());
  if (!relevant.length) return [];

  await lockItems(
    tx,
    relevant.map((c) => c.itemId),
  );

  const updated = new Map<string, InventoryItem>();
  const movements: Prisma.InventoryMovementCreateManyInput[] = [];

  for (const c of [...relevant].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const item = await tx.inventoryItem.update({
      where: { id: c.itemId },
      data: { currentStock: { increment: c.delta } },
    });

    if (!opts.allowNegative && item.currentStock.isNegative()) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', `Stock insuficiente de "${item.name}"`, {
        itemId: item.id,
        available: item.currentStock.sub(c.delta).toNumber(),
        requested: c.delta.abs().toNumber(),
        unit: item.unit,
      });
    }

    updated.set(item.id, item);
    movements.push({
      type: c.type,
      inventoryItemId: item.id,
      itemName: item.name,
      quantity: c.delta,
      stockAfter: item.currentStock,
      unit: item.unit,
      unitCost: c.unitCost ?? item.unitCost,
      originLocation: c.origin ?? null,
      destinationLocation: c.destination ?? null,
      reason: c.reason ?? null,
      userId: actor?.id ?? null,
      userName: actor?.name ?? null,
      saleId: c.saleId ?? null,
      transferGroupId: c.transferGroupId ?? null,
    });
  }

  await tx.inventoryMovement.createMany({ data: movements });
  return [...updated.values()];
}

export function isLowStock(item: InventoryItem): boolean {
  return item.isActive && item.currentStock.lte(item.minimumStock);
}

/** Notifica a todos los dispositivos. Llamar DESPUÉS del commit. */
export function publishInventoryChanges(items: InventoryItem[]) {
  if (!items.length) return;
  publish(RealtimeEvents.INVENTORY_UPDATED, { items });
  const low = items.filter(isLowStock);
  if (low.length) publish(RealtimeEvents.INVENTORY_LOW_STOCK, { items: low }, { room: Rooms.STAFF });
}

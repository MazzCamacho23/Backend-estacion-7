/**
 * Catálogo de eventos en tiempo real que el servidor emite.
 * Cada evento llega con el sobre: { data, emittedAt }.
 *
 * Estrategia de sincronización recomendada en Android:
 *  1. Al conectar (o reconectar) el socket -> pedir por REST lo que cambió
 *     con ?updatedSince=<último emittedAt guardado>.
 *  2. Mientras esté conectado -> aplicar los eventos (upsert en Room).
 */
export const RealtimeEvents = {
  SESSION_READY: 'session.ready',

  PRODUCT_UPSERTED: 'product.upserted',

  INVENTORY_UPDATED: 'inventory.updated', // { items: InventoryItem[] }
  INVENTORY_LOW_STOCK: 'inventory.low_stock', // { items: InventoryItem[] }

  TABLE_UPSERTED: 'table.upserted', // OpenTable con items
  TABLE_CLOSED: 'table.closed', // { id, label, status, saleId? }

  SALE_CREATED: 'sale.created',
  SALE_REFUNDED: 'sale.refunded',

  SHIFT_UPDATED: 'shift.updated',
} as const;

export type RealtimeEvent = (typeof RealtimeEvents)[keyof typeof RealtimeEvents];

export const Rooms = {
  STAFF: 'staff', // Todos los usuarios autenticados
  OWNERS: 'owners', // Solo administradores
  user: (id: string) => `user:${id}`,
} as const;

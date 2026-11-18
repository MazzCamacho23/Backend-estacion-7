import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest } from '../../lib/errors';
import type { Tx } from '../../lib/prisma';
import { prisma } from '../../lib/prisma';

/**
 * La app Android trae una lista fija de leches con IDs propios. Se traducen a los
 * productos de la categoría "Leches" del catálogo (que tienen el precio real).
 *  - leche entera = la leche base de la receta: no es una sustitución.
 *  - deslactosada / soya: no están configuradas como producto todavía.
 */
const MILK_ALIASES: Record<string, string | null> = {
  leche_entera: null,
  leche_avena: '31',
  leche_almendra: '32',
};
const UNCONFIGURED_MILKS: Record<string, string> = {
  leche_deslactosada: 'Leche deslactosada',
  leche_soya: 'Leche de soya',
};

const milkOptionIdSchema = z
  .string()
  .trim()
  .nullish()
  .transform((id) => {
    if (!id) return null;
    if (id in MILK_ALIASES) return MILK_ALIASES[id]!;
    if (id in UNCONFIGURED_MILKS) {
      throw badRequest(
        `${UNCONFIGURED_MILKS[id]} no está configurada en el catálogo. Véndela con leche entera o pide a una administradora que la cree en "Leches".`,
        'MILK_NOT_CONFIGURED',
        { milkOptionId: id },
      );
    }
    return id;
  });

/** Lo que manda el celular por cada producto (sin precios: los pone el servidor). */
export const lineInputSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  toppingIds: z.array(z.string().min(1)).max(10).default([]),
  milkOptionId: milkOptionIdSchema,
  observations: z.string().trim().max(300).nullish(),
});
export type LineInput = z.infer<typeof lineInputSchema>;

export interface ModifierSnapshot {
  productId: string;
  name: string;
  price: number;
  kind: 'TOPPING' | 'MILK';
  /** Solo MILK: insumo que reemplaza a la leche base de la receta. */
  milkItemId?: string;
}

export interface PricedLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  modifiers: ModifierSnapshot[];
  observations: string | null;
}

type Db = Tx | typeof prisma;

/**
 * Valida productos y adiciones (existen y están activos) y calcula el precio.
 * unitPrice = precio base + suma de adiciones/leche.
 */
export async function priceLines(db: Db, inputs: LineInput[]): Promise<PricedLine[]> {
  const ids = new Set<string>();
  for (const l of inputs) {
    ids.add(l.productId);
    l.toppingIds.forEach((t) => ids.add(t));
    if (l.milkOptionId) ids.add(l.milkOptionId);
  }

  const products = await db.product.findMany({ where: { id: { in: [...ids] } } });
  const byId = new Map(products.map((p) => [p.id, p]));

  const get = (id: string) => {
    const p = byId.get(id);
    if (!p) throw badRequest(`Producto no existe: ${id}`, 'PRODUCT_NOT_FOUND', { productId: id });
    if (!p.isActive) throw badRequest(`"${p.name}" está deshabilitado`, 'PRODUCT_INACTIVE', { productId: id });
    return p;
  };

  return inputs.map((l) => {
    const product = get(l.productId);
    const modifiers: ModifierSnapshot[] = [
      ...l.toppingIds.map((id) => {
        const t = get(id);
        return { productId: t.id, name: t.name, price: t.price, kind: 'TOPPING' as const };
      }),
      ...(l.milkOptionId
        ? [(() => {
            const m = get(l.milkOptionId!);
            if (!m.milkInventoryItemId) {
              throw badRequest(
                `"${m.name}" no es una opción de leche (le falta milkInventoryItemId)`,
                'NOT_A_MILK_OPTION',
                { productId: m.id },
              );
            }
            return {
              productId: m.id,
              name: m.name,
              price: m.price,
              kind: 'MILK' as const,
              milkItemId: m.milkInventoryItemId,
            };
          })()]
        : []),
    ];
    const unitPrice = product.price + modifiers.reduce((acc, m) => acc + m.price, 0);
    return {
      productId: product.id,
      productName: product.name,
      quantity: l.quantity,
      unitPrice,
      subtotal: unitPrice * l.quantity,
      modifiers,
      observations: l.observations ?? null,
    };
  });
}

export interface ConsumptionResult {
  /** Costo de insumos por línea (mismo orden que las líneas), en COP. */
  lineCosts: number[];
  /** Cantidad total a descontar por insumo. */
  totals: Map<string, Prisma.Decimal>;
}

/**
 * Explota las recetas: producto principal + cada adición/leche (si tienen receta),
 * multiplicado por la cantidad. Productos sin receta no descuentan inventario.
 *
 * Sustitución de leche: si la línea trae una opción MILK, cada ingrediente de
 * receta marcado `isMilk` se descuenta del insumo de esa leche (misma cantidad)
 * en vez de la leche base. Ej: Cappuccino (180 ml leche entera) + Almendras
 * => descuenta 180 ml de leche de almendras y 0 de leche entera.
 */
export async function computeConsumption(
  tx: Tx,
  lines: { productId: string; quantity: number; modifiers: ModifierSnapshot[] }[],
): Promise<ConsumptionResult> {
  const productIds = new Set<string>();
  lines.forEach((l) => {
    productIds.add(l.productId);
    l.modifiers.forEach((m) => productIds.add(m.productId));
  });

  const recipes = await tx.recipe.findMany({
    where: { productId: { in: [...productIds] }, isActive: true },
    include: { ingredients: { include: { item: true } } },
  });
  const recipeByProduct = new Map(recipes.map((r) => [r.productId, r]));

  const milkItemIds = new Set<string>();
  lines.forEach((l) => l.modifiers.forEach((m) => m.kind === 'MILK' && m.milkItemId && milkItemIds.add(m.milkItemId)));
  const milkItems = milkItemIds.size
    ? await tx.inventoryItem.findMany({ where: { id: { in: [...milkItemIds] } } })
    : [];
  const milkItemById = new Map(milkItems.map((i) => [i.id, i]));

  const totals = new Map<string, Prisma.Decimal>();
  const lineCosts = lines.map((line) => {
    const milkSwapId = line.modifiers.find((m) => m.kind === 'MILK' && m.milkItemId)?.milkItemId;
    const milkSwap = milkSwapId ? milkItemById.get(milkSwapId) : undefined;
    if (milkSwapId && !milkSwap) {
      throw badRequest('El insumo de la leche seleccionada ya no existe', 'MILK_ITEM_NOT_FOUND', { milkSwapId });
    }

    let cost = new Prisma.Decimal(0);
    for (const pid of [line.productId, ...line.modifiers.map((m) => m.productId)]) {
      const recipe = recipeByProduct.get(pid);
      if (!recipe) continue;
      for (const ing of recipe.ingredients) {
        const item = ing.isMilk && milkSwap ? milkSwap : ing.item;
        const qty = ing.quantity.mul(line.quantity);
        totals.set(item.id, (totals.get(item.id) ?? new Prisma.Decimal(0)).add(qty));
        cost = cost.add(qty.mul(item.unitCost));
      }
    }
    return Math.round(cost.toNumber());
  });

  return { lineCosts, totals };
}

export function parseModifiers(json: Prisma.JsonValue): ModifierSnapshot[] {
  return Array.isArray(json) ? (json as unknown as ModifierSnapshot[]) : [];
}

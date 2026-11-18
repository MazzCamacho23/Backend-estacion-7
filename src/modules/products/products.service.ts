import { InventoryLocation, Prisma, type Product } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { RealtimeEvents } from '../../realtime/events';
import { publish } from '../../realtime/socket';

type ProductWithRecipeRef = Product & { recipe: { id: string } | null };

function present(p: ProductWithRecipeRef) {
  const { recipe, ...rest } = p;
  return { ...rest, recipeId: recipe?.id ?? null };
}

const withRecipeRef = { recipe: { select: { id: true } } } as const;

export async function listProducts(filter: { category?: string; active?: boolean; updatedSince?: Date }) {
  const products = await prisma.product.findMany({
    where: {
      category: filter.category,
      isActive: filter.active,
      updatedAt: filter.updatedSince ? { gt: filter.updatedSince } : undefined,
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: withRecipeRef,
  });
  return products.map(present);
}

export async function getProduct(id: string) {
  const p = await prisma.product.findUnique({ where: { id }, include: withRecipeRef });
  if (!p) throw notFound('Producto no encontrado');
  return present(p);
}

export interface ProductInput {
  id?: string;
  name: string;
  category: string;
  price: number;
  isActive?: boolean;
  description?: string | null;
  preparationTimeSeconds?: number;
  milkInventoryItemId?: string | null;
}

/** La leche alternativa debe ser un insumo del punto de venta (de ahí se descuenta). */
async function validateMilkItem(id: string | null | undefined) {
  if (!id) return;
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw badRequest(`Insumo no existe: ${id}`, 'UNKNOWN_INGREDIENTS', { missing: [id] });
  if (item.location !== InventoryLocation.POINT_OF_SALE) {
    throw badRequest('La leche debe ser un insumo del PUNTO DE VENTA', 'INGREDIENT_NOT_IN_POS', { ids: [id] });
  }
}

export async function createProduct(data: ProductInput) {
  await validateMilkItem(data.milkInventoryItemId);
  const p = await prisma.product.create({ data, include: withRecipeRef });
  const out = present(p);
  publish(RealtimeEvents.PRODUCT_UPSERTED, out);
  return out;
}

export async function updateProduct(id: string, data: Partial<Omit<ProductInput, 'id'>>) {
  await validateMilkItem(data.milkInventoryItemId);
  const p = await prisma.product.update({ where: { id }, data, include: withRecipeRef });
  const out = present(p);
  publish(RealtimeEvents.PRODUCT_UPSERTED, out);
  return out;
}

// ----------------------------------------------------------------------------
//  Recetas
// ----------------------------------------------------------------------------

export async function getRecipe(productId: string) {
  const recipe = await prisma.recipe.findUnique({
    where: { productId },
    include: { ingredients: { include: { item: true }, orderBy: { item: { name: 'asc' } } } },
  });
  if (!recipe) throw notFound('Este producto no tiene receta');

  const ingredients = recipe.ingredients.map((ri) => {
    const lineCost = ri.quantity.mul(ri.item.unitCost);
    return {
      id: ri.id,
      ingredientId: ri.inventoryItemId,
      ingredientName: ri.item.name,
      quantity: ri.quantity,
      isMilk: ri.isMilk,
      unit: ri.item.unit,
      costPerUnit: ri.item.unitCost,
      lineCost: Math.round(lineCost.toNumber()),
    };
  });
  return {
    id: recipe.id,
    productId: recipe.productId,
    preparationTimeSeconds: recipe.preparationTimeSeconds,
    isActive: recipe.isActive,
    updatedAt: recipe.updatedAt,
    ingredients,
    estimatedCost: ingredients.reduce((acc, i) => acc + i.lineCost, 0),
  };
}

export interface RecipeInput {
  preparationTimeSeconds: number;
  isActive: boolean;
  ingredients: { ingredientId: string; quantity: number; isMilk: boolean }[];
}

/** Reemplaza la receta completa (PUT idempotente). */
export async function upsertRecipe(productId: string, input: RecipeInput) {
  const ids = input.ingredients.map((i) => i.ingredientId);
  if (new Set(ids).size !== ids.length) throw badRequest('Hay insumos repetidos en la receta');
  if (input.ingredients.filter((i) => i.isMilk).length > 1) {
    throw badRequest('Solo un ingrediente de la receta puede marcarse como leche (isMilk)', 'MULTIPLE_MILK');
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw notFound('Producto no encontrado');

  const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } } });
  const missing = ids.filter((id) => !items.some((it) => it.id === id));
  if (missing.length) throw badRequest('Insumos inexistentes', 'UNKNOWN_INGREDIENTS', { missing });
  const notPos = items.filter((it) => it.location !== InventoryLocation.POINT_OF_SALE).map((it) => it.id);
  if (notPos.length) {
    throw badRequest(
      'Las recetas solo pueden usar insumos del PUNTO DE VENTA (las ventas descuentan de ahí)',
      'INGREDIENT_NOT_IN_POS',
      { ids: notPos },
    );
  }

  await prisma.$transaction(async (tx) => {
    const recipe = await tx.recipe.upsert({
      where: { productId },
      create: { productId, preparationTimeSeconds: input.preparationTimeSeconds, isActive: input.isActive },
      update: { preparationTimeSeconds: input.preparationTimeSeconds, isActive: input.isActive },
    });
    await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
    await tx.recipeIngredient.createMany({
      data: input.ingredients.map((i) => ({
        recipeId: recipe.id,
        inventoryItemId: i.ingredientId,
        quantity: new Prisma.Decimal(i.quantity),
        isMilk: i.isMilk,
      })),
    });
    await tx.product.update({
      where: { id: productId },
      data: { preparationTimeSeconds: input.preparationTimeSeconds },
    });
  });

  publish(RealtimeEvents.PRODUCT_UPSERTED, await getProduct(productId));
  return getRecipe(productId);
}

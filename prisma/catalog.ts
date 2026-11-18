/**
 * Catálogo OFICIAL de Estación Siete Café: productos, insumos y recetas.
 *
 * Fuente: app Android (CatalogRepository.kt, InventoryRepository.kt, Recipe.kt),
 * importado el 2026-11-16. Se conservan los IDs de la app para que el mapeo sea 1:1.
 *
 * `syncCatalog()` es idempotente y NO destructivo:
 *  - Crea lo que falta y actualiza metadatos (nombres, precios, costos, mínimos).
 *  - El stock solo se fija al CREAR un insumo (después lo manejan los movimientos).
 *  - Los insumos que ya no están en el catálogo se DESACTIVAN (no se borran: conservan historial).
 *  - Los productos de ejemplo antiguos se borran solo si nunca se vendieron.
 */
import { InventoryItemType, InventoryLocation, MovementType, Prisma, type PrismaClient } from '@prisma/client';

const D = (n: number) => new Prisma.Decimal(n);

// ---------------------------------------------------------------------------
//  Insumos (baseKey). pos/wh = stock inicial y mínimo por ubicación.
//  Si una ubicación no aplica (ej: brownie solo en POS), se omite.
// ---------------------------------------------------------------------------
interface ItemSeed {
  key: string;
  name: string;
  unit: 'g' | 'ml' | 'unidad';
  cost: number; // COP por unidad base
  supplier?: string;
  type?: InventoryItemType;
  pos?: { stock: number; min: number };
  wh?: { stock: number; min: number };
}

const VASOS = 'Envases Colombia';

export const INVENTORY: ItemSeed[] = [
  // Vasos (descuento exacto por tamaño)
  { key: 'vaso_carton_4', name: 'Vaso de cartón 4oz', unit: 'unidad', cost: 150, supplier: VASOS, pos: { stock: 100, min: 30 }, wh: { stock: 500, min: 100 } },
  { key: 'vaso_carton_7', name: 'Vaso de cartón 7oz', unit: 'unidad', cost: 200, supplier: VASOS, pos: { stock: 100, min: 30 }, wh: { stock: 500, min: 100 } },
  { key: 'vaso_carton_9', name: 'Vaso de cartón 9oz', unit: 'unidad', cost: 250, supplier: VASOS, pos: { stock: 100, min: 30 }, wh: { stock: 500, min: 100 } },
  { key: 'vaso_plastico_14', name: 'Vaso de plástico 14oz', unit: 'unidad', cost: 300, supplier: VASOS, pos: { stock: 100, min: 30 }, wh: { stock: 500, min: 100 } },
  { key: 'vaso_plastico_16', name: 'Vaso de plástico 16oz', unit: 'unidad', cost: 350, supplier: VASOS, pos: { stock: 100, min: 30 }, wh: { stock: 500, min: 100 } },
  // Ingredientes base
  { key: 'cafe', name: 'Café en grano', unit: 'g', cost: 15, supplier: 'Café Colombia SAS', pos: { stock: 500, min: 200 }, wh: { stock: 5000, min: 1000 } },
  { key: 'leche', name: 'Leche entera', unit: 'ml', cost: 3, supplier: 'Lácteos La Finca', pos: { stock: 2000, min: 1000 }, wh: { stock: 20000, min: 4000 } },
  { key: 'leche_polvo', name: 'Leche en polvo', unit: 'g', cost: 10, supplier: 'Lácteos La Finca', pos: { stock: 800, min: 200 }, wh: { stock: 5000, min: 1000 } },
  { key: 'azucar', name: 'Azúcar', unit: 'g', cost: 2, supplier: 'Azucarera Nacional', pos: { stock: 500, min: 200 }, wh: { stock: 10000, min: 2000 } },
  { key: 'milo', name: 'Milo en polvo', unit: 'g', cost: 12, supplier: 'Nestlé', pos: { stock: 500, min: 200 }, wh: { stock: 5000, min: 1000 } },
  { key: 'chai', name: 'Chai en polvo', unit: 'g', cost: 25, supplier: 'Chai Express', pos: { stock: 300, min: 100 }, wh: { stock: 3000, min: 500 } },
  { key: 'chocolate', name: 'Chocolate en polvo', unit: 'g', cost: 50, supplier: 'Chocolates Premium', pos: { stock: 200, min: 50 }, wh: { stock: 2000, min: 500 } },
  { key: 'chocolate_sirope', name: "Hershey's Chocolate", unit: 'ml', cost: 12, supplier: "Hershey's", pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'caramelo', name: 'Sirope Arequipe/Caramelo', unit: 'ml', cost: 6, supplier: 'Sirope Premium', pos: { stock: 300, min: 100 }, wh: { stock: 3000, min: 500 } },
  { key: 'vainilla_sirope', name: 'Sirope Vainilla', unit: 'ml', cost: 6, supplier: 'Sirope Premium', pos: { stock: 300, min: 100 }, wh: { stock: 3000, min: 500 } },
  { key: 'panela', name: 'Syrope Miel Panela', unit: 'ml', cost: 5, supplier: 'Panela Real', pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'matcha', name: 'Matcha japonés', unit: 'g', cost: 50, supplier: 'Matcha Co', pos: { stock: 100, min: 30 }, wh: { stock: 1000, min: 200 } },
  { key: 'proteina', name: 'Proteína en polvo', unit: 'g', cost: 40, supplier: 'NutriFit', pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'baileys', name: 'Crema Baileys', unit: 'ml', cost: 60, supplier: 'Licorera Central', pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'ron', name: 'Shot de Ron', unit: 'ml', cost: 45, supplier: 'Licorera Central', pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'whisky', name: 'Shot de Whisky', unit: 'ml', cost: 75, supplier: 'Licorera Central', pos: { stock: 300, min: 100 }, wh: { stock: 2000, min: 500 } },
  { key: 'hielo', name: 'Hielo en cubos', unit: 'g', cost: 1, supplier: 'Hielo Express', pos: { stock: 1000, min: 300 }, wh: { stock: 10000, min: 2000 } },
  { key: 'mym', name: 'Chocolates M&M', unit: 'g', cost: 20, supplier: 'Dulces y Cía', pos: { stock: 200, min: 50 }, wh: { stock: 2000, min: 500 } },
  { key: 'oreo', name: 'Galletas Oreo', unit: 'unidad', cost: 800, supplier: 'Nabisco', pos: { stock: 20, min: 5 }, wh: { stock: 100, min: 20 } },
  { key: 'infusion', name: 'Sobres Infusión', unit: 'unidad', cost: 1200, supplier: 'Frutalia', pos: { stock: 30, min: 5 }, wh: { stock: 200, min: 30 } },
  { key: 'pulpa_soda', name: 'Pulpa para soda', unit: 'unidad', cost: 1500, supplier: 'Frutalia', pos: { stock: 20, min: 5 }, wh: { stock: 100, min: 20 } },
  { key: 'soda_bretana', name: 'Soda Bretaña', unit: 'ml', cost: 8, supplier: 'Postobón', pos: { stock: 1000, min: 300 }, wh: { stock: 5000, min: 1000 } },
  { key: 'naranja', name: 'Jugo de Naranja', unit: 'ml', cost: 10, supplier: 'Cítricos del Valle', pos: { stock: 500, min: 100 }, wh: { stock: 3000, min: 500 } },
  // Productos terminados (solo punto de venta)
  { key: 'galleta', name: 'Galleta de avena', unit: 'unidad', cost: 1500, supplier: 'Panadería Central', type: InventoryItemType.FINISHED_PRODUCT, pos: { stock: 20, min: 5 } },
  { key: 'brownie', name: 'Brownie', unit: 'unidad', cost: 2500, supplier: 'Panadería Central', type: InventoryItemType.FINISHED_PRODUCT, pos: { stock: 15, min: 3 } },
  // ⚠ NUEVOS (no existían en la app). Stock 0 y costo ESTIMADO: confirmar con una entrada de mercancía.
  { key: 'canela', name: 'Canela en polvo', unit: 'g', cost: 2, pos: { stock: 0, min: 20 }, wh: { stock: 0, min: 100 } }, // la usa el Barraquito
  { key: 'leche_avena', name: 'Leche de avena', unit: 'ml', cost: 12, pos: { stock: 0, min: 500 }, wh: { stock: 0, min: 2000 } }, // opción de leche
  { key: 'leche_almendra', name: 'Leche de almendra', unit: 'ml', cost: 12, pos: { stock: 0, min: 500 }, wh: { stock: 0, min: 2000 } }, // opción de leche
];

// ---------------------------------------------------------------------------
//  Productos (IDs idénticos a la app)
// ---------------------------------------------------------------------------
interface ProductSeed {
  id: string;
  name: string;
  category: string;
  price: number;
  description: string;
  milkKey?: string; // Solo categoría "Leches": insumo que reemplaza a la leche base
}

const BC = 'Bebidas Calientes';
const BF = 'Bebidas Frías';
const E7 = 'Especiales 7';
const EL = 'Especiales con Licor';

export const PRODUCTS: ProductSeed[] = [
  { id: '1', name: 'Espresso 4oz', category: BC, price: 6000, description: 'Café concentrado espresso 4oz' },
  { id: '2', name: 'Espresso Doble 4oz', category: BC, price: 7500, description: 'Doble extracción de café espresso 4oz' },
  { id: '3', name: 'Americano 7oz', category: BC, price: 6000, description: 'Espresso diluido con agua caliente 7oz' },
  { id: '3b', name: 'Americano Doble 7oz', category: BC, price: 7500, description: 'Doble espresso diluido con agua caliente 7oz' },
  { id: '3c', name: 'Americano 9oz (Doble)', category: BC, price: 8500, description: 'Americano doble en vaso 9oz' },
  { id: '3d', name: 'Americano Campesino 7oz', category: BC, price: 7000, description: 'Americano con syrope miel panela 7oz' },
  { id: '4', name: 'Macchiato 4oz', category: BC, price: 7000, description: 'Espresso con mancha de leche 4oz' },
  { id: '4b', name: 'Macchiato Doble 4oz', category: BC, price: 8500, description: 'Espresso doble con mancha de leche 4oz' },
  { id: '5', name: 'Moca 9oz', category: BC, price: 12000, description: 'Espresso con chocolate y leche en vaso 9oz' },
  { id: '6', name: 'Cappuccino Clásico 7oz', category: BC, price: 8500, description: 'Espresso con leche cremosa en vaso 7oz' },
  { id: '6b', name: 'Cappuccino Clásico 9oz', category: BC, price: 10000, description: 'Espresso con leche cremosa en vaso 9oz' },
  { id: '6c', name: 'Flat White 9oz', category: BC, price: 10500, description: 'Doble espresso con leche texturizada 9oz' },
  { id: '6d', name: 'Latte Clásico 9oz', category: BC, price: 10000, description: 'Espresso con leche suave vaporizada 9oz' },
  { id: '7', name: 'Cappuccino Vainilla 9oz', category: BC, price: 12500, description: 'Cappuccino con syrope de vainilla 9oz' },
  { id: '7b', name: 'Cappuccino Caramelo 9oz', category: BC, price: 12500, description: 'Cappuccino con syrope de caramelo 9oz' },
  { id: '7c', name: 'Cappuccino Campesino 9oz', category: BC, price: 11500, description: 'Cappuccino con syrope miel panela 9oz' },
  { id: '7d', name: 'CapuMilo 9oz', category: BC, price: 12000, description: 'Cappuccino cremoso vaporizado con Milo 9oz' },

  { id: '8', name: 'Granizado Café 14oz', category: BF, price: 16000, description: 'Bebida helada de café con arequipe 14oz' },
  { id: '9', name: 'FrappuBrownie 14oz', category: BF, price: 18000, description: 'Granizado con trozos de brownie 14oz' },
  { id: '10', name: 'Granizado M&M 14oz', category: BF, price: 20000, description: 'Granizado helado con chocolates M&M 14oz' },
  { id: '11', name: 'MiloCoffee 14oz', category: BF, price: 18000, description: 'Frappé frío de café con Milo 14oz' },
  { id: '12', name: 'Matcha a la Roca 14oz', category: BF, price: 16000, description: 'Té matcha helado a la roca 14oz' },
  { id: '13', name: 'Protein Coffee 14oz', category: BF, price: 20000, description: 'Batido proteico frío con café 14oz' },
  { id: '14', name: 'Infusión Fría 12oz', category: BF, price: 9000, description: 'Infusión herbal o frutal helada 12oz' },
  { id: '37', name: 'Granizado de Oreo 14oz', category: BF, price: 18000, description: 'Granizado frappeado con Oreo 14oz' },
  { id: '38', name: 'FrappuBaileys 14oz', category: BF, price: 20000, description: 'Frappé cremoso con crema Baileys 14oz' },
  { id: '39', name: 'Soda Frutos Rojos/Amarillos 12oz', category: BF, price: 12000, description: 'Soda refrescante con pulpa de fruta 12oz' },
  { id: '40', name: 'Cold Brew Especial 14oz', category: BF, price: 15000, description: 'Cold brew con jugo de naranja y soda 14oz' },

  { id: '15', name: 'Milo Caliente 9oz', category: E7, price: 10000, description: 'Bebida de chocolate Milo caliente 9oz' },
  { id: '16', name: 'Chai Latte 9oz', category: E7, price: 12500, description: 'Té especiado Chai con leche 9oz' },
  { id: '17', name: 'Matcha Caliente 9oz', category: E7, price: 12000, description: 'Té verde matcha servido caliente 9oz' },
  { id: '18', name: 'Infusión Caliente 7oz', category: E7, price: 7000, description: 'Selección de tés calientes 7oz' },
  { id: '19', name: 'Bebida de Temporada', category: E7, price: 15000, description: 'Especialidad creada por nuestros baristas' },

  { id: '20', name: 'Carajillo 4oz', category: EL, price: 10000, description: 'Café espresso con toque de Ron 4oz' },
  { id: '21', name: 'Chai Baileys 14oz', category: EL, price: 20000, description: 'Chai frappeado con crema Baileys 14oz' },
  { id: '22', name: 'Barraquito 4oz', category: EL, price: 12500, description: 'Café multicapa con Whisky y canela 4oz' },
  { id: '23', name: 'Cappuccino + Amaretto 9oz', category: EL, price: 15000, description: 'Cappuccino cremoso con licor de Amaretto 9oz' },

  { id: '24', name: 'Crema Chantilly', category: 'Adiciones', price: 3000, description: 'Adición de crema chantilly de la casa' },
  { id: '25', name: 'Salsa Caramelo', category: 'Adiciones', price: 3500, description: 'Adición de sirope de caramelo dulce' },
  { id: '26', name: 'Sabor Vainilla', category: 'Adiciones', price: 3500, description: 'Toque de extracto o jarabe de vainilla' },
  { id: '27', name: 'Toque Amaretto', category: 'Adiciones', price: 6000, description: 'Adición de licor de amaretto' },
  { id: '28', name: "Salsa Hershey's", category: 'Adiciones', price: 4000, description: "Salsa de chocolate Hershey's premium" },
  { id: '29', name: 'Shot Ron', category: 'Adiciones', price: 4500, description: 'Shot de ron para personalizar tu bebida' },
  { id: '30', name: 'Shot Whisky', category: 'Adiciones', price: 7500, description: 'Shot de whisky premium' },

  { id: '31', name: 'Leche de Avena', category: 'Leches', price: 6000, description: 'Sustitución o adición de leche vegetal de avena', milkKey: 'leche_avena' },
  { id: '32', name: 'Leche de Almendra', category: 'Leches', price: 4000, description: 'Sustitución o adición de leche vegetal de almendra', milkKey: 'leche_almendra' },

  { id: '33', name: 'Dedito de Queso', category: 'Para Acompañar', price: 6000, description: 'Dedito horneado crujiente relleno de queso' },
  { id: '34', name: 'Torta de la Casa', category: 'Para Acompañar', price: 6000, description: 'Porción de torta fresca del día' },
  { id: '35', name: 'Torta de Zanahoria', category: 'Para Acompañar', price: 9000, description: 'Esponjosa torta de zanahoria con cobertura especial' },
  { id: '36', name: 'Brownie', category: 'Para Acompañar', price: 6000, description: 'Brownie melcochudo de chocolate artesanal' },
];

// ---------------------------------------------------------------------------
//  Recetas (productId -> baseKey: cantidad por unidad). Insumos del POS.
//  'leche' se marca isMilk: la reemplaza la leche alternativa elegida.
// ---------------------------------------------------------------------------
export const BASE_MILK_KEY = 'leche';

export const RECIPES: Record<string, { prep: number; ingredients: Record<string, number> }> = {
  '1': { prep: 30, ingredients: { cafe: 10, vaso_carton_4: 1 } },
  '2': { prep: 35, ingredients: { cafe: 18, vaso_carton_4: 1 } },
  '3': { prep: 35, ingredients: { cafe: 10, vaso_carton_7: 1 } },
  '4': { prep: 40, ingredients: { cafe: 10, leche: 20, vaso_carton_4: 1 } },
  '5': { prep: 75, ingredients: { cafe: 18, leche: 150, chocolate: 25, vaso_carton_9: 1 } },
  // ⚠ Ajustado: en la app el Cappuccino 7oz descontaba vaso de 9oz. Aquí usa vaso 7oz y leche estimada (140 ml).
  '6': { prep: 60, ingredients: { cafe: 10, leche: 140, vaso_carton_7: 1 } },
  '6b': { prep: 60, ingredients: { cafe: 10, leche: 180, vaso_carton_9: 1 } },
  '7': { prep: 65, ingredients: { cafe: 10, leche: 180, vainilla_sirope: 25, vaso_carton_9: 1 } },
  // ⚠ Derivado: la app usaba una sola receta "Vainilla/Caramelo". El de caramelo descuenta sirope de caramelo.
  '7b': { prep: 65, ingredients: { cafe: 10, leche: 180, caramelo: 25, vaso_carton_9: 1 } },
  '15': { prep: 60, ingredients: { milo: 80, leche: 200, vaso_carton_9: 1 } },
  '16': { prep: 60, ingredients: { chai: 30, leche: 200, vaso_carton_9: 1 } },
  '18': { prep: 45, ingredients: { infusion: 1, vaso_carton_7: 1 } },
  '20': { prep: 45, ingredients: { cafe: 10, ron: 30, vaso_carton_4: 1 } },
  '22': { prep: 50, ingredients: { cafe: 10, whisky: 20, canela: 2, vaso_carton_4: 1 } },
  '8': { prep: 90, ingredients: { cafe: 18, leche_polvo: 80, azucar: 15, caramelo: 20, hielo: 150, vaso_plastico_14: 1 } },
  '9': { prep: 120, ingredients: { cafe: 18, leche_polvo: 80, azucar: 15, chocolate_sirope: 20, brownie: 1, hielo: 150, vaso_plastico_14: 1 } },
  '10': { prep: 110, ingredients: { cafe: 18, leche_polvo: 80, azucar: 5, caramelo: 20, mym: 48, hielo: 150, vaso_plastico_14: 1 } },
  '11': { prep: 100, ingredients: { cafe: 18, milo: 120, leche_polvo: 80, azucar: 10, chocolate_sirope: 20, hielo: 150, vaso_plastico_14: 1 } },
  '12': { prep: 60, ingredients: { matcha: 2, leche: 120, hielo: 150, vaso_plastico_14: 1 } },
  '13': { prep: 90, ingredients: { cafe: 10, proteina: 30, caramelo: 20, hielo: 150, vaso_plastico_14: 1 } },
  '14': { prep: 45, ingredients: { infusion: 2, hielo: 150, vaso_plastico_14: 1 } },
  '21': { prep: 90, ingredients: { chai: 50, leche_polvo: 80, baileys: 30, hielo: 150, vaso_plastico_14: 1 } },
  '37': { prep: 110, ingredients: { cafe: 18, leche_polvo: 80, azucar: 10, chocolate_sirope: 17, oreo: 3, hielo: 150, vaso_plastico_14: 1 } },
  '38': { prep: 100, ingredients: { cafe: 10, leche_polvo: 80, azucar: 15, baileys: 20, caramelo: 15, hielo: 150, vaso_plastico_14: 1 } },
  '39': { prep: 50, ingredients: { pulpa_soda: 1, soda_bretana: 180, hielo: 150, vaso_plastico_16: 1 } },
  '40': { prep: 60, ingredients: { cafe: 30, naranja: 45, azucar: 30, soda_bretana: 150, hielo: 150, vaso_plastico_14: 1 } },
  // ⚠ Agregado: el Brownie es producto terminado; venderlo descuenta 1 unidad del inventario.
  '36': { prep: 0, ingredients: { brownie: 1 } },
};

/** Productos de ejemplo del primer seed (se eliminan si nunca se vendieron). */
const LEGACY_EXAMPLE_PRODUCT_IDS = [
  'espresso_4oz', 'americano_7oz', 'cappuccino_9oz', 'latte_9oz', 'mocaccino_9oz',
  'granizado_cafe_14oz', 'frappe_caramelo_16oz', 'cafe_irlandes_9oz',
  'add_shot_espresso', 'add_vainilla', 'add_chantilly', 'milk_deslactosada', 'milk_almendras', 'brownie',
];

const itemId = (key: string, loc: InventoryLocation) =>
  `${loc === InventoryLocation.POINT_OF_SALE ? 'pos' : 'wh'}_${key}`;

export interface SyncReport {
  legacyProductsDeleted: number;
  legacyProductsKept: string[];
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeactivated: string[];
  productsUpserted: number;
  recipes: number;
}

export async function syncCatalog(prisma: PrismaClient, actor: { id: string; name: string }): Promise<SyncReport> {
  const report: SyncReport = {
    legacyProductsDeleted: 0, legacyProductsKept: [], itemsCreated: 0, itemsUpdated: 0,
    itemsDeactivated: [], productsUpserted: 0, recipes: 0,
  };

  // 1) Productos de ejemplo: borrar solo si nunca se vendieron ni están en una mesa.
  for (const id of LEGACY_EXAMPLE_PRODUCT_IDS) {
    const p = await prisma.product.findUnique({
      where: { id },
      include: { _count: { select: { saleItems: true, openTableItems: true } } },
    });
    if (!p) continue;
    if (p._count.saleItems || p._count.openTableItems) {
      await prisma.product.update({ where: { id }, data: { isActive: false } });
      report.legacyProductsKept.push(id);
    } else {
      await prisma.product.delete({ where: { id } }); // recetas en cascada
      report.legacyProductsDeleted++;
    }
  }

  // 2) Insumos
  const wanted = new Set<string>();
  for (const it of INVENTORY) {
    for (const loc of [InventoryLocation.POINT_OF_SALE, InventoryLocation.WAREHOUSE]) {
      const cfg = loc === InventoryLocation.POINT_OF_SALE ? it.pos : it.wh;
      if (!cfg) continue;
      const id = itemId(it.key, loc);
      wanted.add(id);
      const meta = {
        baseKey: it.key,
        name: it.name,
        type: it.type ?? InventoryItemType.BASE_INGREDIENT,
        location: loc,
        unit: it.unit,
        unitCost: D(it.cost),
        minimumStock: D(cfg.min),
        supplier: it.supplier ?? null,
        isActive: true,
      };
      const exists = await prisma.inventoryItem.findUnique({ where: { id } });
      if (exists) {
        await prisma.inventoryItem.update({ where: { id }, data: meta });
        report.itemsUpdated++;
      } else {
        await prisma.$transaction([
          prisma.inventoryItem.create({ data: { id, ...meta, currentStock: D(cfg.stock) } }),
          prisma.inventoryMovement.create({
            data: {
              type: MovementType.INPUT, inventoryItemId: id, itemName: it.name,
              quantity: D(cfg.stock), stockAfter: D(cfg.stock), unit: it.unit, unitCost: D(it.cost),
              destinationLocation: loc, reason: 'Stock inicial (catálogo oficial)',
              userId: actor.id, userName: actor.name,
            },
          }),
        ]);
        report.itemsCreated++;
      }
    }
  }
  const stale = await prisma.inventoryItem.findMany({ where: { id: { notIn: [...wanted] }, isActive: true } });
  for (const s of stale) {
    await prisma.inventoryItem.update({ where: { id: s.id }, data: { isActive: false } });
    report.itemsDeactivated.push(s.id);
  }

  // 3) Productos
  for (const p of PRODUCTS) {
    const data = {
      name: p.name,
      category: p.category,
      price: p.price,
      description: p.description,
      milkInventoryItemId: p.milkKey ? itemId(p.milkKey, InventoryLocation.POINT_OF_SALE) : null,
      preparationTimeSeconds: RECIPES[p.id]?.prep ?? 0,
    };
    await prisma.product.upsert({ where: { id: p.id }, update: data, create: { id: p.id, ...data } });
    report.productsUpserted++;
  }

  // 4) Recetas (se reemplazan completas)
  for (const [productId, r] of Object.entries(RECIPES)) {
    await prisma.$transaction(async (tx) => {
      const recipe = await tx.recipe.upsert({
        where: { productId },
        update: { preparationTimeSeconds: r.prep, isActive: true },
        create: { productId, preparationTimeSeconds: r.prep },
      });
      await tx.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
      await tx.recipeIngredient.createMany({
        data: Object.entries(r.ingredients).map(([key, qty]) => ({
          recipeId: recipe.id,
          inventoryItemId: itemId(key, InventoryLocation.POINT_OF_SALE),
          quantity: D(qty),
          isMilk: key === BASE_MILK_KEY,
        })),
      });
    });
    report.recipes++;
  }

  return report;
}

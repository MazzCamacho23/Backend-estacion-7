/**
 * Importa los datos que la app guardó OFFLINE en el celular de la tienda
 * (archivos JSON extraídos con `adb exec-out run-as ... cat files/*.json`).
 *
 *   npx tsx scripts/import-phone-data.ts data-import/raw-XXXX            -> simulación (no guarda nada)
 *   npx tsx scripts/import-phone-data.ts data-import/raw-XXXX --apply    -> guarda en la base
 *
 * Decisiones (confirmadas con el negocio el 2026-11-17):
 *  - Catálogo oficial = el del celular (nombres y precios que se cobran hoy).
 *  - Stock = el del celular (se registra como MANUAL_ADJUSTMENT en el kardex).
 *  - Michel y Jeniffer se crean como EMPLOYEE; "Necibeth"/sellerId "2" = Nescibeth.
 *  - Los turnos del celular NO se importan (estaban incompletos).
 *  - Las ventas conservan su UUID original (idempotente: se puede correr varias
 *    veces y solo agrega las nuevas) y se renumeran cronológicamente, porque los
 *    tickets del celular eran aleatorios y tenían repetidos.
 *  - No se re-descuenta inventario por las ventas históricas: el stock del
 *    celular ya las tiene descontadas.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import {
  CourtesyType, InventoryItemType, InventoryLocation, MovementType, PaymentMethod,
  Prisma, PrismaClient, Role, SaleMode, SaleStatus,
} from '@prisma/client';

const dir = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!dir) throw new Error('Uso: tsx scripts/import-phone-data.ts <carpeta> [--apply]');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T;

// ---------- Formato de los archivos del celular ----------
interface PhoneProduct { id: string; name: string; category: string; price: number; description?: string; isActive?: boolean }
interface PhoneItem { id: string; name: string; location?: string; currentStock: number; minimumStock: number; unit: string; unitCost: number; supplier?: string }
interface PhoneSaleItem {
  productId: string; productName: string; quantity: number; priceAtSale: number;
  toppings?: { id: string; name: string; price: number }[];
  milkOption?: { id: string; name: string; extraPrice: number } | null;
  observations?: string; saleMode?: 'INDIVIDUAL' | 'TABLE_GROUP'; tableNumber?: string | null; ingredientCost?: number;
}
interface PhoneSale {
  id: string; ticketId: string; timestamp: number; items: PhoneSaleItem[]; subtotal: number; total: number;
  paymentInfo: {
    method: 'CASH' | 'TRANSFER' | 'CARD_TERMINAL' | 'COURTESY'; reference?: string | null; receivedAmount?: number | null;
    changeAmount?: number; courtesyBeneficiary?: string | null; courtesyType?: string | null; courtesyNotes?: string | null;
  };
  status?: string; sellerId: string; sellerName: string; tableNumber?: string | null; ingredientCost?: number;
}

const catalog = read<PhoneProduct[]>('catalog_data.json');
const inventory = read<PhoneItem[]>('inventory_data.json');
const sales = read<PhoneSale[]>('sales_data.json').sort((a, b) => a.timestamp - b.timestamp);

const prisma = new PrismaClient();
const D = (n: number) => new Prisma.Decimal(n);
const warnings: string[] = [];

/** Vendedores del celular -> usuario del servidor. */
const NEW_EMPLOYEES: Record<string, { name: string; email: string }> = {
  'e391e604-5ce2-4ae6-beec-e3fc4245e888': { name: 'Michel', email: 'michel@estacionsiete.co' },
  'ddc818ee-2f15-4933-a4fc-717ed577bcf3': { name: 'Jeniffer', email: 'jeniffer@estacionsiete.co' },
};
const EXISTING_BY_PHONE_ID: Record<string, string> = { '2': 'nescibeth@estacionsiete.co' };

function validate() {
  const productIds = new Set(catalog.map((p) => p.id));
  if (productIds.size !== catalog.length) throw new Error('Catálogo con IDs repetidos');
  const ids = new Set<string>();
  for (const s of sales) {
    if (ids.has(s.id)) throw new Error(`Venta repetida ${s.id}`);
    ids.add(s.id);
    if (!NEW_EMPLOYEES[s.sellerId] && !EXISTING_BY_PHONE_ID[s.sellerId]) throw new Error(`Vendedor desconocido ${s.sellerId} ${s.sellerName}`);
    let sum = 0;
    for (const i of s.items) {
      if (!productIds.has(i.productId)) throw new Error(`Venta ${s.ticketId}: producto ${i.productId} no está en el catálogo`);
      if (i.toppings?.length) throw new Error(`Venta ${s.ticketId}: tiene toppings, no soportado por el importador`);
      if (i.milkOption && (i.milkOption.id !== 'leche_entera' || i.milkOption.extraPrice)) throw new Error(`Venta ${s.ticketId}: leche alternativa no soportada`);
      if (i.quantity <= 0) throw new Error(`Venta ${s.ticketId}: cantidad inválida`);
      sum += i.priceAtSale * i.quantity;
    }
    if (sum !== s.subtotal || s.total !== s.subtotal) throw new Error(`Venta ${s.ticketId}: totales no cuadran`);
    if (s.status && s.status !== 'APPROVED') throw new Error(`Venta ${s.ticketId}: estado ${s.status} no soportado`);
  }
}

function locationOf(id: string) {
  if (id.startsWith('pos_')) return { loc: InventoryLocation.POINT_OF_SALE, key: id.slice(4) };
  if (id.startsWith('wh_')) return { loc: InventoryLocation.WAREHOUSE, key: id.slice(3) };
  throw new Error(`Insumo con ID inesperado: ${id}`);
}

async function main() {
  validate();
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'adalina@estacionsiete.co' } });
  const passwordHash = await bcrypt.hash(process.env.SEED_DEFAULT_PASSWORD ?? 'Cambiar123*', 12);
  const summary: Record<string, unknown> = {};

  try {
  await prisma.$transaction(async (tx) => {
    // ---------- 1) Usuarios ----------
    const sellerMap = new Map<string, { id: string; name: string }>();
    let usersCreated = 0;
    for (const [phoneId, u] of Object.entries(NEW_EMPLOYEES)) {
      let user = await tx.user.findFirst({ where: { OR: [{ id: phoneId }, { email: u.email }] } });
      if (!user) {
        user = await tx.user.create({ data: { id: phoneId, name: u.name, email: u.email, role: Role.EMPLOYEE, passwordHash } });
        usersCreated++;
      }
      sellerMap.set(phoneId, { id: user.id, name: user.name });
    }
    for (const [phoneId, email] of Object.entries(EXISTING_BY_PHONE_ID)) {
      const user = await tx.user.findUniqueOrThrow({ where: { email } });
      sellerMap.set(phoneId, { id: user.id, name: user.name });
    }
    summary.usuariosCreados = usersCreated;

    // ---------- 2) Catálogo ----------
    let created = 0, updated = 0;
    for (const p of catalog) {
      const data = { name: p.name.trim(), category: p.category, price: p.price, description: p.description ?? null, isActive: p.isActive ?? true };
      const exists = await tx.product.findUnique({ where: { id: p.id } });
      if (exists) { await tx.product.update({ where: { id: p.id }, data }); updated++; }
      else { await tx.product.create({ data: { id: p.id, ...data } }); created++; }
    }
    const extra = await tx.product.updateMany({ where: { id: { notIn: catalog.map((p) => p.id) }, isActive: true }, data: { isActive: false } });
    const noRecipe = await tx.product.findMany({ where: { isActive: true, recipe: null, category: { not: 'Leches' } }, select: { name: true } });
    summary.productos = { creados: created, actualizados: updated, desactivadosNoEstanEnCelular: extra.count, sinReceta: noRecipe.map((p) => p.name) };

    // ---------- 3) Inventario (stock del celular) ----------
    let itemsCreated = 0, adjusted = 0;
    for (const it of inventory) {
      const { loc, key } = locationOf(it.id);
      const current = await tx.inventoryItem.findUnique({ where: { id: it.id } });
      if (!current) {
        const clash = await tx.inventoryItem.findUnique({ where: { baseKey_location: { baseKey: key, location: loc } } });
        if (clash) throw new Error(`Insumo ${it.id} choca con ${clash.id}`);
        const type = it.unit === 'unidad' && /torta|dedito|brownie|galleta|croissant/i.test(it.name)
          ? InventoryItemType.FINISHED_PRODUCT : InventoryItemType.BASE_INGREDIENT;
        await tx.inventoryItem.create({
          data: {
            id: it.id, baseKey: key, name: it.name, type, location: loc, unit: it.unit,
            currentStock: D(it.currentStock), minimumStock: D(it.minimumStock), unitCost: D(it.unitCost),
            supplier: it.supplier ?? null,
            movements: {
              create: {
                type: MovementType.INPUT, itemName: it.name, quantity: D(it.currentStock), stockAfter: D(it.currentStock),
                unit: it.unit, unitCost: D(it.unitCost), destinationLocation: loc,
                reason: 'Stock inicial importado del celular de la tienda', userId: owner.id, userName: owner.name,
              },
            },
          },
        });
        itemsCreated++;
        if (it.unit === 'g' && it.unitCost > 1000) warnings.push(`${it.id}: unidad "g" con costo $${it.unitCost} por gramo (¿debería ser "unidad"?)`);
        continue;
      }
      if (current.unit !== it.unit) warnings.push(`${it.id}: unidad en servidor "${current.unit}" vs celular "${it.unit}" (se dejó la del servidor)`);
      const delta = D(it.currentStock).minus(current.currentStock);
      await tx.inventoryItem.update({ where: { id: it.id }, data: { currentStock: D(it.currentStock), isActive: true } });
      if (!delta.isZero()) {
        await tx.inventoryMovement.create({
          data: {
            type: MovementType.MANUAL_ADJUSTMENT, inventoryItemId: it.id, itemName: current.name, quantity: delta,
            stockAfter: D(it.currentStock), unit: current.unit, unitCost: current.unitCost,
            originLocation: delta.isNegative() ? loc : null, destinationLocation: delta.isNegative() ? null : loc,
            reason: 'Ajuste: stock real del celular de la tienda (importación)', userId: owner.id, userName: owner.name,
          },
        });
        adjusted++;
      }
      if (Number(current.unitCost) !== it.unitCost) warnings.push(`${it.id}: costo servidor $${current.unitCost} vs celular $${it.unitCost} (se dejó el del servidor)`);
    }
    for (const it of inventory) {
      if (it.unit !== 'unidad' && it.currentStock > it.minimumStock * 40 && it.currentStock > 5000)
        warnings.push(`${it.id}: stock ${it.currentStock} ${it.unit} parece muy alto, revisar con conteo físico`);
    }
    const notInPhone = await tx.inventoryItem.findMany({ where: { isActive: true, id: { notIn: inventory.map((i) => i.id) } }, select: { id: true } });
    summary.inventario = { creados: itemsCreated, ajustados: adjusted, soloEnServidorSinConteo: notInPhone.map((i) => i.id) };

    // ---------- 4) Ventas ----------
    const already = new Set((await tx.sale.findMany({ where: { id: { in: sales.map((s) => s.id) } }, select: { id: true } })).map((s) => s.id));
    const pending = sales.filter((s) => !already.has(s.id));
    const maxTicket = (await tx.sale.aggregate({ _max: { ticketNumber: true } }))._max.ticketNumber ?? 999;
    if (pending.length && sales.some((s) => already.has(s.id) && s.timestamp > pending[0]!.timestamp))
      warnings.push('Hay ventas nuevas más antiguas que otras ya importadas: sus tickets no quedarán en orden cronológico');

    const saleRows: Prisma.SaleCreateManyInput[] = [];
    const itemRows: Prisma.SaleItemCreateManyInput[] = [];
    const payRows: Prisma.SalePaymentCreateManyInput[] = [];
    pending.forEach((s, idx) => {
      const seller = sellerMap.get(s.sellerId)!;
      const at = new Date(s.timestamp);
      const pi = s.paymentInfo;
      const isCourtesy = pi.method === 'COURTESY';
      const total = isCourtesy ? 0 : s.total;
      const tableLabel = s.tableNumber ?? s.items.find((i) => i.tableNumber)?.tableNumber ?? null;
      const ingredientCost = s.items.reduce((a, i) => a + (i.ingredientCost ?? 0) * i.quantity, 0);
      saleRows.push({
        id: s.id, ticketNumber: maxTicket + 1 + idx, clientRequestId: `phone:${s.id}`, createdAt: at,
        subtotal: s.subtotal, total, status: SaleStatus.APPROVED, sellerId: seller.id, sellerName: seller.name,
        tableLabel, ingredientCost, grossMargin: total - ingredientCost, isCourtesy,
        courtesyBeneficiary: isCourtesy ? (pi.courtesyBeneficiary?.trim() || 'Sin especificar') : null,
        courtesyType: isCourtesy ? ((pi.courtesyType as CourtesyType | undefined) && pi.courtesyType! in CourtesyType ? (pi.courtesyType as CourtesyType) : CourtesyType.INVITADO) : null,
        courtesyNotes: isCourtesy ? (pi.courtesyNotes?.trim() || null) : null,
      });
      for (const i of s.items) {
        itemRows.push({
          saleId: s.id, productId: i.productId, productName: i.productName, quantity: i.quantity,
          unitPrice: i.priceAtSale, subtotal: i.priceAtSale * i.quantity, modifiers: [],
          observations: i.observations?.trim() || null,
          saleMode: i.saleMode === 'TABLE_GROUP' ? SaleMode.TABLE_GROUP : SaleMode.INDIVIDUAL,
          tableLabel: i.tableNumber ?? null, ingredientCost: (i.ingredientCost ?? 0) * i.quantity,
        });
      }
      payRows.push({
        saleId: s.id, method: PaymentMethod[pi.method], amount: total, createdAt: at,
        reference: pi.method === 'TRANSFER' || pi.method === 'CARD_TERMINAL' ? (pi.reference?.trim() || null) : null,
        receivedAmount: pi.method === 'CASH' ? (pi.receivedAmount ?? total) : null,
        changeAmount: pi.method === 'CASH' ? (pi.changeAmount ?? 0) : null,
      });
    });
    if (saleRows.length) {
      await tx.sale.createMany({ data: saleRows });
      await tx.saleItem.createMany({ data: itemRows });
      await tx.salePayment.createMany({ data: payRows });
      // La secuencia sigue después del último ticket importado.
      await tx.$executeRaw`SELECT setval('sales_ticket_number_seq', (SELECT MAX(ticket_number) FROM sales))`;
    }
    const range = pending.length
      ? `${pending[0]!.ticketId}… -> tickets ${maxTicket + 1}..${maxTicket + pending.length}` : '-';
    summary.ventas = { enCelular: sales.length, yaImportadas: already.size, nuevas: pending.length, tickets: range };

    if (!APPLY) throw new DryRun();
  }, { maxWait: 20_000, timeout: 180_000 });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return summary;
}

class DryRun extends Error {}

main()
  .then((s) => {
    console.log(APPLY ? "✅ IMPORTACIÓN GUARDADA" : "🧪 SIMULACIÓN (nada se guardó; usa --apply para guardar)");
    console.log(JSON.stringify(s, null, 2));
    if (warnings.length) console.log("⚠️  Revisar:\n - " + [...new Set(warnings)].join("\n - "));
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

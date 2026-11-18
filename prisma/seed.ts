/**
 * Datos iniciales de Estación Siete Café: usuarios + catálogo oficial.
 * Es idempotente y no destructivo: se puede correr varias veces, y sobre una
 * base existente sincroniza el catálogo sin tocar ventas ni stock existente.
 *
 *   npm run db:seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, Role } from '@prisma/client';
import { INVENTORY, PRODUCTS, RECIPES, syncCatalog } from './catalog';

const prisma = new PrismaClient();
const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? 'Cambiar123*';

const USERS = [
  { name: 'Adalina Fonseca', email: 'adalina@estacionsiete.co', role: Role.OWNER },
  { name: 'Glori Fonseca', email: 'glori@estacionsiete.co', role: Role.OWNER },
  { name: 'Leonel', email: 'leonel@estacionsiete.co', role: Role.EMPLOYEE },
  { name: 'Nescibeth', email: 'nescibeth@estacionsiete.co', role: Role.EMPLOYEE },
];

async function seedUsers() {
  let created = 0;
  for (const u of USERS) {
    const exists = await prisma.user.findUnique({ where: { email: u.email } });
    if (exists) continue; // Nunca se pisa un usuario existente (ni su contraseña).
    await prisma.user.create({ data: { ...u, passwordHash: await bcrypt.hash(DEFAULT_PASSWORD, 12) } });
    created++;
  }
  console.log(`✔ Usuarios: ${created} nuevos (contraseña inicial: ${DEFAULT_PASSWORD})`);
  return prisma.user.findUniqueOrThrow({ where: { email: USERS[0]!.email } });
}

function validateCatalog() {
  const posKeys = new Set(INVENTORY.filter((i) => i.pos).map((i) => i.key));
  const productIds = new Set(PRODUCTS.map((p) => p.id));
  for (const [pid, r] of Object.entries(RECIPES)) {
    if (!productIds.has(pid)) throw new Error(`Receta para producto inexistente: ${pid}`);
    for (const key of Object.keys(r.ingredients)) {
      if (!posKeys.has(key)) throw new Error(`Receta ${pid} usa insumo sin ubicación POS: ${key}`);
    }
  }
  for (const p of PRODUCTS) {
    if (p.milkKey && !posKeys.has(p.milkKey)) throw new Error(`Leche ${p.id} apunta a insumo inexistente: ${p.milkKey}`);
  }
}

async function main() {
  validateCatalog();
  const owner = await seedUsers();
  // Con ventas reales, el catálogo oficial es el que se administra desde la app
  // (importado del celular de la tienda el 2026-11-17). El seed no lo pisa salvo
  // que se pida explícitamente.
  const salesCount = await prisma.sale.count();
  if (salesCount > 0 && process.env.SEED_FORCE_CATALOG !== '1') {
    console.log(`↷ Catálogo NO sincronizado: la base ya tiene ${salesCount} ventas (usa SEED_FORCE_CATALOG=1 para forzar)`);
    return;
  }
  const r = await syncCatalog(prisma, owner);
  console.log(`✔ Productos de ejemplo eliminados: ${r.legacyProductsDeleted}` +
    (r.legacyProductsKept.length ? ` (conservados por tener ventas: ${r.legacyProductsKept.join(', ')})` : ''));
  console.log(`✔ Insumos: ${r.itemsCreated} creados, ${r.itemsUpdated} actualizados` +
    (r.itemsDeactivated.length ? `, ${r.itemsDeactivated.length} desactivados (${r.itemsDeactivated.join(', ')})` : ''));
  console.log(`✔ Productos: ${r.productsUpserted} · Recetas: ${r.recipes}`);
  console.log('☕ Seed completado');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

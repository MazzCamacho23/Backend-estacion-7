// Prueba de humo E2E: simula un celular de vendedor y una tablet de administrador.
// ⚠ Crea ventas, turnos y movimientos: correr SOLO contra una BD de pruebas recién
//   migrada + seed, NUNCA contra producción.
//
//   SMOKE_URL=http://localhost:3100 npm run test:smoke      (por defecto http://localhost:3000)
const { io } = require('socket.io-client');
const crypto = require('crypto');
const BASE = process.env.SMOKE_URL || 'http://localhost:3000';
const API = BASE + '/api/v1';
let pass = 0, fail = 0;

// Catálogo oficial (prisma/catalog.ts)
const P = {
  americano: '3', // $6.000 · café 10g + vaso cartón 7oz
  cappuccino9: '6b', // $10.000 · café 10g + leche 180ml + vaso cartón 9oz
  latte: '6d', // $10.000 · sin receta
  granizado: '8', // $16.000 · café 18g + ... + vaso plástico 14oz
  brownie: '36', // $6.000 · 1 brownie (producto terminado)
  vainilla: '26', // Adición $3.500 (sin receta)
  almendra: '32', // Leche $4.000 -> reemplaza leche entera por pos_leche_almendra
};

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const stock = async (t, id) => (await call('GET', '/inventory/items/' + id, t)).body.currentStock;
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`\nAPI: ${BASE}`);
  console.log('\n[Auth]');
  const ownerLogin = await call('POST', '/auth/login', null, { email: 'adalina@estacionsiete.local', password: 'Cambiar123*' });
  check('login administrador', ownerLogin.status === 200 && ownerLogin.body.user.role === 'OWNER', ownerLogin);
  const empLogin = await call('POST', '/auth/login', null, { email: 'leonel@estacionsiete.local', password: 'Cambiar123*' });
  check('login vendedor', empLogin.status === 200, empLogin);
  const bad = await call('POST', '/auth/login', null, { email: 'leonel@estacionsiete.local', password: 'x' });
  check('contraseña incorrecta -> 401 INVALID_CREDENTIALS', bad.status === 401 && bad.body.error.code === 'INVALID_CREDENTIALS');
  const OWNER = ownerLogin.body.accessToken, EMP = empLogin.body.accessToken;

  const r1 = await call('POST', '/auth/refresh', null, { refreshToken: empLogin.body.refreshToken });
  check('refresh token rota', r1.status === 200 && r1.body.refreshToken !== empLogin.body.refreshToken);
  const reuse = await call('POST', '/auth/refresh', null, { refreshToken: empLogin.body.refreshToken });
  check('reusar refresh viejo -> 401 (detección de robo)', reuse.status === 401);
  const r2 = await call('POST', '/auth/refresh', null, { refreshToken: r1.body.refreshToken });
  check('...y revoca toda la familia de sesiones', r2.status === 401);

  const forb = await call('GET', '/reports/sales-summary', EMP);
  check('vendedor no accede a reportes -> 403', forb.status === 403);
  const noTok = await call('GET', '/products', null);
  check('sin token -> 401', noTok.status === 401);
  const h = await fetch(API + '/health').then((r) => r.json());
  check('GET /api/v1/health público', h.status === 'ok');

  console.log('\n[WebSockets]');
  const events = { owner: [], emp: [] };
  const connect = (token, bucket) => new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.onAny((ev, payload) => events[bucket].push({ ev, payload }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const sOwner = await connect(OWNER, 'owner');
  const sEmp = await connect(EMP, 'emp');
  check('2 dispositivos conectados', sOwner.connected && sEmp.connected);
  const badSock = await new Promise((r) => {
    const s = io(BASE, { auth: { token: 'basura' }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => r('connected')); s.on('connect_error', (e) => r(e.message));
  });
  check('socket con token inválido rechazado', badSock === 'TOKEN_EXPIRED_OR_INVALID', badSock);

  console.log('\n[Catálogo oficial]');
  const prods = await call('GET', '/products', EMP);
  check('50 productos del catálogo oficial', prods.body.length === 50, prods.body.length);
  check('precio real: Cappuccino 9oz $10.000', prods.body.find((p) => p.id === P.cappuccino9)?.price === 10000);
  const off = await call('PATCH', `/products/${P.latte}/active`, OWNER, { isActive: false });
  check('admin apaga Latte', off.status === 200 && off.body.isActive === false);
  const recipe = await call('GET', `/products/${P.cappuccino9}/recipe`, OWNER);
  check('receta cappuccino 9oz: costo 10*15 + 180*3 + 250 = $940', recipe.body.estimatedCost === 940, recipe.body.estimatedCost);

  console.log('\n[Turnos y ventas]');
  const noShift = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.americano, quantity: 1 }], payments: [{ method: 'CASH', amount: 6000 }] });
  check('vender sin turno -> 409 SHIFT_NOT_OPEN', noShift.status === 409 && noShift.body.error.code === 'SHIFT_NOT_OPEN', noShift.body);
  const shift = await call('POST', '/shifts/open', EMP, { startingCash: 50000 });
  check('abrir turno con base $50.000', shift.status === 201 && shift.body.isOpen, shift.body);
  const shift2 = await call('POST', '/shifts/open', EMP, { startingCash: 50000 });
  check('abrir turno 2 veces -> 409', shift2.status === 409);

  const inactive = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.latte, quantity: 1 }], payments: [{ method: 'CASH', amount: 10000 }] });
  check('vender producto apagado -> 400 PRODUCT_INACTIVE', inactive.body?.error?.code === 'PRODUCT_INACTIVE', inactive.body);

  const before = { cafe: await stock(OWNER, 'pos_cafe'), leche: await stock(OWNER, 'pos_leche'), vaso: await stock(OWNER, 'pos_vaso_carton_9') };
  const saleBody = { clientRequestId: uuid(), items: [{ productId: P.cappuccino9, quantity: 2, toppingIds: [P.vainilla], observations: 'sin azúcar' }], payments: [{ method: 'CASH', amount: 27000, receivedAmount: 30000 }] };
  const sale = await call('POST', '/sales', EMP, saleBody);
  check('venta 2 cappuccino 9oz + vainilla = $27.000', sale.status === 201 && sale.body.total === 27000, sale.body);
  check('vuelto $3.000', sale.body.payments?.[0]?.changeAmount === 3000);
  check('ticket empieza en 1000', sale.body.ticketNumber >= 1000, sale.body.ticketNumber);
  check('vendedor NO ve costos/margen', sale.body.ingredientCost === undefined && sale.body.grossMargin === undefined);
  const after = { cafe: await stock(OWNER, 'pos_cafe'), leche: await stock(OWNER, 'pos_leche'), vaso: await stock(OWNER, 'pos_vaso_carton_9') };
  check('descuenta café 20g', before.cafe - after.cafe === 20, [before.cafe, after.cafe]);
  check('descuenta leche entera 360ml', before.leche - after.leche === 360);
  check('descuenta 2 vasos cartón 9oz', before.vaso - after.vaso === 2);

  console.log('\n[Sustitución de leche]');
  const mb = { leche: await stock(OWNER, 'pos_leche'), alm: await stock(OWNER, 'pos_leche_almendra'), cafe: await stock(OWNER, 'pos_cafe') };
  const milkSale = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.cappuccino9, quantity: 1, milkOptionId: P.almendra }], payments: [{ method: 'TRANSFER', amount: 14000, reference: 'NEQUI-777' }] });
  check('cappuccino 9oz + leche de almendra = $14.000', milkSale.status === 201 && milkSale.body.total === 14000, milkSale.body);
  check('NO descuenta leche entera', (await stock(OWNER, 'pos_leche')) === mb.leche);
  check('descuenta 180ml de leche de almendra', mb.alm - (await stock(OWNER, 'pos_leche_almendra')) === 180);
  check('el resto de la receta igual (café 10g)', mb.cafe - (await stock(OWNER, 'pos_cafe')) === 10);
  const notMilk = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.cappuccino9, quantity: 1, milkOptionId: P.vainilla }], payments: [{ method: 'CASH', amount: 13500 }] });
  check('milkOptionId que no es leche -> 400 NOT_A_MILK_OPTION', notMilk.body?.error?.code === 'NOT_A_MILK_OPTION', notMilk.body);
  const rcp = await call('GET', `/products/${P.cappuccino9}/recipe`, OWNER);
  check('receta expone isMilk en leche entera', rcp.body.ingredients.some((i) => i.ingredientId === 'pos_leche' && i.isMilk));

  const replay = await call('POST', '/sales', EMP, saleBody);
  check('reintento mismo clientRequestId -> 200 misma venta', replay.status === 200 && replay.body.id === sale.body.id);
  check('...sin descontar inventario de nuevo', (await stock(OWNER, 'pos_cafe')) === after.cafe - 10);

  const mismatch = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.americano, quantity: 1 }], payments: [{ method: 'CASH', amount: 3000 }] });
  check('pago no cuadra -> 400 PAYMENT_MISMATCH', mismatch.body?.error?.code === 'PAYMENT_MISMATCH');

  const split = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.granizado, quantity: 1 }], payments: [{ method: 'CASH', amount: 6000 }, { method: 'TRANSFER', amount: 10000, reference: 'NEQUI-123' }] });
  check('pago mixto efectivo + transferencia ($16.000)', split.status === 201 && split.body.total === 16000, split.body);

  console.log('\n[Cortesías]');
  const brownieBefore = await stock(OWNER, 'pos_brownie');
  const court = await call('POST', '/sales', OWNER, { clientRequestId: uuid(), items: [{ productId: P.brownie, quantity: 1 }, { productId: P.americano, quantity: 1 }], courtesy: { beneficiary: 'Adalina Fonseca', type: 'ADMINISTRADOR', notes: 'Reunión de socios' } });
  check('cortesía total $0, subtotal $12.000', court.status === 201 && court.body.total === 0 && court.body.subtotal === 12000, court.body);
  check('cortesía SÍ descuenta inventario (brownie)', brownieBefore - (await stock(OWNER, 'pos_brownie')) === 1);
  check('admin ve costo real de la cortesía', court.body.ingredientCost > 0, court.body.ingredientCost);

  console.log('\n[Mesas]');
  const t = await call('POST', '/tables', EMP, { label: 'Mesa 4 - Carlos', items: [{ productId: P.americano, quantity: 2 }] });
  check('abrir mesa con productos ($12.000)', t.status === 201 && t.body.total === 12000, t.body);
  const dup = await call('POST', '/tables', OWNER, { label: 'mesa 4 -  carlos' });
  check('mesa duplicada abierta -> 409', dup.status === 409 && dup.body.error.code === 'TABLE_LABEL_IN_USE', dup.body);
  const badT = await call('POST', '/tables', EMP, { label: 'Mesa X', items: [{ productId: 'no_existe', quantity: 1 }] });
  const ghost = (await call('GET', '/tables', EMP)).body.find((x) => x.label === 'Mesa X');
  check('producto inválido no deja mesa a medias', badT.status === 400 && !ghost);
  const add = await call('POST', `/tables/${t.body.id}/items`, OWNER, { items: [{ productId: P.granizado, quantity: 1 }] });
  check('otro dispositivo agrega a la misma mesa ($28.000)', add.body.total === 28000 && add.body.items.length === 2, add.body);
  const pay = { payments: [{ method: 'CARD_TERMINAL', amount: 28000, reference: 'DAT-998' }] };
  const [c1, c2] = await Promise.all([
    call('POST', '/sales', EMP, { clientRequestId: uuid(), openTableId: t.body.id, ...pay }),
    call('POST', '/sales', OWNER, { clientRequestId: uuid(), openTableId: t.body.id, ...pay }),
  ]);
  const codes = [c1.status, c2.status].sort();
  check('cobro simultáneo: uno 201 y otro 409 (sin doble cobro)', codes[0] === 201 && codes[1] === 409, [c1.body, c2.body]);
  const reopenLabel = await call('POST', '/tables', EMP, { label: 'Mesa 4 - Carlos' });
  check('nombre de mesa se libera al cobrarla', reopenLabel.status === 201);
  const cancel = await call('DELETE', `/tables/${reopenLabel.body.id}`, EMP);
  check('eliminar mesa sin cobrar', cancel.body.status === 'CANCELLED');

  console.log('\n[Inventario]');
  const whBefore = await stock(OWNER, 'wh_cafe'), posBefore = await stock(OWNER, 'pos_cafe');
  const tr = await call('POST', '/inventory/movements/transfer', EMP, { baseKey: 'cafe', quantity: 500 });
  check('traslado bodega -> POS 500g', tr.status === 201 && (await stock(OWNER, 'wh_cafe')) === whBefore - 500 && (await stock(OWNER, 'pos_cafe')) === posBefore + 500, tr.body);
  const trBig = await call('POST', '/inventory/movements/transfer', EMP, { baseKey: 'cafe', quantity: 999999 });
  check('traslado mayor al stock -> 409 INSUFFICIENT_STOCK', trBig.body?.error?.code === 'INSUFFICIENT_STOCK', trBig.body);
  const adj = await call('POST', '/inventory/movements/adjustment', OWNER, { itemId: 'pos_hielo', countedStock: 200, reason: 'Conteo físico cierre' });
  check('ajuste por conteo físico', adj.body.currentStock === 200);
  const low = await call('GET', '/inventory/items?lowStock=true', OWNER);
  check('alerta stock bajo (hielo)', low.body.some((i) => i.id === 'pos_hielo'));
  const input = await call('POST', '/inventory/movements/input', OWNER, { itemId: 'wh_leche', quantity: 12000, unitCost: 5, supplier: 'Alquería' });
  check('entrada con costo promedio ponderado (3 -> 3,75)', input.status === 201 && input.body.unitCost === 3.75, input.body.unitCost);
  const movs = await call('GET', `/inventory/movements?saleId=${sale.body.id}`, OWNER);
  check('auditoría: 3 movimientos de la venta (café, leche, vaso)', movs.body.total === 3, movs.body.total);

  console.log('\n[Anulación]');
  const cafeBeforeRefund = await stock(OWNER, 'pos_cafe');
  const ref = await call('POST', `/sales/${split.body.id}/refund`, OWNER, { reason: 'Cliente se arrepintió', restock: true });
  check('anular venta con reintegro', ref.status === 200 && ref.body.status === 'REFUNDED', ref.body);
  check('reintegra café 18g', (await stock(OWNER, 'pos_cafe')) === cafeBeforeRefund + 18);
  const ref2 = await call('POST', `/sales/${split.body.id}/refund`, OWNER, { reason: 'otra vez', restock: true });
  check('anular 2 veces -> 409', ref2.status === 409);

  console.log('\n[Cierre de caja]');
  const cur = await call('GET', '/shifts/current', EMP);
  check('turno en vivo: efectivo esperado $77.000', cur.body.shift.live.expectedCash === 77000, cur.body.shift.live);
  const close = await call('POST', `/shifts/${cur.body.shift.id}/close`, EMP, { countedCash: 76000, notes: 'Faltan mil' });
  check('cierre: faltante -$1.000', close.body.cashDifference === -1000 && close.body.totalTickets >= 1, close.body);
  const afterClose = await call('POST', '/sales', EMP, { clientRequestId: uuid(), items: [{ productId: P.americano, quantity: 1 }], payments: [{ method: 'CASH', amount: 6000 }] });
  check('vender con turno cerrado -> 409', afterClose.status === 409);

  console.log('\n[Reportes]');
  const sum = await call('GET', '/reports/sales-summary', OWNER);
  check('resumen del día ($69.000)', sum.status === 200 && sum.body.revenue === 27000 + 14000 + 28000 && sum.body.courtesyTickets === 1, sum.body);
  const top = await call('GET', '/reports/top-products', OWNER);
  check('top productos', top.status === 200 && top.body.products.length > 0);
  const cts = await call('GET', '/reports/courtesies', OWNER);
  check('cortesías por beneficiario', cts.body.byBeneficiary[0]?.beneficiary === 'Adalina Fonseca', cts.body);
  for (const p of ['/reports/sales-by-seller', '/reports/sales-by-hour', '/reports/inventory-valuation']) {
    const r = await call('GET', p, OWNER);
    check('GET ' + p, r.status === 200, r.body);
  }

  await sleep(500);
  console.log('\n[Eventos en tiempo real recibidos]');
  const count = (b) => events[b].reduce((a, e) => ((a[e.ev] = (a[e.ev] || 0) + 1), a), {});
  console.log('  admin   :', JSON.stringify(count('owner')));
  console.log('  vendedor:', JSON.stringify(count('emp')));
  const empSale = events.emp.find((e) => e.ev === 'sale.created');
  const ownSale = events.owner.find((e) => e.ev === 'sale.created');
  check('vendedor recibe sale.created SIN costos', empSale && empSale.payload.data.ingredientCost === undefined);
  check('admin recibe sale.created CON costos', ownSale && ownSale.payload.data.ingredientCost !== undefined);
  check('ambos reciben product.upserted (Latte apagado)', count('emp')['product.upserted'] >= 1 && count('owner')['product.upserted'] >= 1);
  check('table.closed llega a todos', count('emp')['table.closed'] >= 2);
  check('alerta inventory.low_stock emitida', count('owner')['inventory.low_stock'] >= 1);
  check('shift.updated llega al vendedor del turno', count('emp')['shift.updated'] >= 1);

  sOwner.close(); sEmp.close();
  console.log(`\nRESULTADO: ${pass} OK, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });

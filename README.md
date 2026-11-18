# ☕ Estación Siete Café — Backend

API REST + WebSockets para el POS/ERP Android de Estación Siete Café.
Conecta tablets y celulares de administradores y vendedores en tiempo real.

**Stack:** Node.js 20+ · TypeScript · Express 5 · PostgreSQL (Neon) · Prisma 6 · Socket.io 4 · Zod · JWT

---

## 0. Cómo funciona (visión general)

```
 Celulares / tablets (app Android)                      Servidor (este repo)                 Base de datos
 ┌──────────────────────────────┐   HTTPS  REST /api/v1   ┌───────────────────────┐   SQL    ┌──────────────┐
 │ Vendedor: cobra, abre mesas, │ ──────────────────────▶ │ Express 5             │ ───────▶ │ PostgreSQL   │
 │ abre/cierra su turno         │                          │  · valida (Zod)       │          │ en Neon      │
 │ Administrador: catálogo,     │ ◀────────────────────── │  · calcula precios    │ ◀─────── │ (pooler)     │
 │ inventario, reportes         │   WebSocket (Socket.io)  │  · descuenta stock    │          └──────────────┘
 └──────────────────────────────┘   eventos en tiempo real │  · emite eventos      │
                                                           └───────────────────────┘
```

1. **El servidor es la única fuente de verdad.** Los celulares no calculan precios ni descuentan inventario: envían *qué* se vendió (`productId`, cantidad, adiciones, leche) y el servidor calcula el total con los precios vigentes, aplica la receta y descuenta los insumos del punto de venta.
2. **Sesión segura.** Cada usuario inicia sesión con correo y contraseña y recibe un *access token* (JWT, 15 min) y un *refresh token* (30 días, rotativo y guardado como hash). Si alguien reutiliza un refresh token ya usado, se cierran todas sus sesiones. Hay dos roles: **OWNER** (administradoras) y **EMPLOYEE** (vendedores).
3. **Una venta, paso a paso** (`POST /sales`), todo dentro de **una sola transacción**:
   1. Si el `clientRequestId` ya existe, devuelve la venta original (reintento seguro, sin duplicar).
   2. Verifica que el vendedor tenga **turno abierto** (los OWNER no lo necesitan).
   3. Calcula precios desde el catálogo y valida los pagos (efectivo con vuelto, transferencia, datáfono, mixto o cortesía).
   4. "Explota" las recetas: cuánto café, leche, vasos, etc. consume cada producto (con sustitución de leche si el cliente pidió una vegetal).
   5. Bloquea las filas de esos insumos, descuenta el stock y deja cada movimiento en el **kardex** (`inventory_movements`).
   6. Guarda la venta con el costo real de insumos y el margen, y le asigna un **número de ticket** consecutivo.
   7. Al confirmar, avisa por WebSocket a todos los celulares (`sale.created`, `inventory.updated`, `shift.updated`).
4. **Tiempo real.** Cuando cambia un producto, una mesa, el inventario o una venta, todos los dispositivos conectados lo reciben al instante. Los vendedores nunca reciben costos ni márgenes.
5. **Turnos de caja.** Cada vendedor abre su turno con una base en efectivo. El servidor suma en vivo lo cobrado y, al cerrar, compara el efectivo esperado con lo contado (faltante/sobrante).
6. **Reportes.** Ventas por día, por hora, por vendedor, productos más vendidos, cortesías y valorización del inventario, siempre en hora de Colombia.

---

## 1. Puesta en marcha

### Requisitos
- Node.js 20 o superior
- PostgreSQL. El proyecto ya está enlazado a **Neon** (`neon.ts`, rama `production`).

### Pasos (Neon)
```bash
npm install
npm i -g neon@latest && neon login
neon env pull                 # escribe DATABASE_URL (pooler) y DATABASE_URL_UNPOOLED (directa) en .env
# asegúrate de tener JWT_ACCESS_SECRET en .env (ver .env.example)
npm run db:deploy             # migraciones (usan la conexión directa)
npm run db:seed               # usuarios, insumos, productos y recetas iniciales
npm run dev                   # http://localhost:3000
```

**Base local en vez de Neon:** `docker compose up -d db` y pon la misma URL local en `DATABASE_URL` y `DATABASE_URL_UNPOOLED`.

**Por qué dos URLs:** la API usa el pooler de Neon (PgBouncer), que soporta muchas conexiones. Las migraciones usan la conexión directa porque necesitan sesión y bloqueos que el pooler no garantiza. Prisma lo maneja con `directUrl` en `schema.prisma`.

Verifica que todo funciona:
```bash
curl http://localhost:3000/health
npm run test:smoke            # 70 verificaciones E2E (SOLO en una BD local recién sembrada)
```

> ⛔ **Nunca corras `test:smoke` contra la base de producción (Neon):** crea ventas, turnos y movimientos de prueba.

### Usuarios
| Nombre | Email | Rol |
|---|---|---|
| Adalina Fonseca | adalina@estacionsiete.local | OWNER |
| Glori Fonseca | glori@estacionsiete.local | OWNER |
| Leonel | leonel@estacionsiete.local | EMPLOYEE |
| Nescibeth | nescibeth@estacionsiete.local | EMPLOYEE |
| Michel | michel@estacionsiete.local | EMPLOYEE (importado del celular) |
| Jeniffer | jeniffer@estacionsiete.local | EMPLOYEE (importado del celular) |

La contraseña inicial es la de `SEED_DEFAULT_PASSWORD`. ⚠️ Cámbiala para cada usuario antes de usar la app en producción (`PATCH /api/v1/users/:id`).

### Seed y catálogo
`npm run db:seed` crea los usuarios que falten (nunca cambia uno existente). El catálogo de `prisma/catalog.ts` **solo se aplica en una base sin ventas**. Con ventas reales, el catálogo oficial es el que se administra desde la app, y el seed no lo modifica salvo que se ejecute con `SEED_FORCE_CATALOG=1`.

### Importar datos del celular (app offline)
Antes del backend, la tienda vendía con la app guardando todo en archivos JSON locales. `scripts/import-phone-data.ts` los sube a la base:
```bash
# 1) Extraer del celular (build debuggable, conectado por USB)
mkdir -p data-import/raw-AAAAMMDD
for f in catalog_data inventory_data sales_data; do
  adb exec-out run-as com.estacion7.caffe.app cat files/$f.json > data-import/raw-AAAAMMDD/$f.json
done
# 2) Simular (no guarda nada) y luego aplicar
npx tsx scripts/import-phone-data.ts data-import/raw-AAAAMMDD
npx tsx scripts/import-phone-data.ts data-import/raw-AAAAMMDD --apply
```
Es **idempotente**: cada venta conserva su UUID del celular, así que correrlo de nuevo solo agrega las ventas nuevas. Los datos extraídos (`data-import/`) **no se suben a git**.

### Scripts
| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm run build` / `npm start` | Compilar y correr en producción |
| `npm run typecheck` | Verificación de tipos |
| `npm run db:migrate` | Crear una nueva migración tras editar `schema.prisma` (desarrollo) |
| `npm run db:deploy` | Aplicar migraciones pendientes (producción) |
| `npm run db:seed` | Datos iniciales (idempotente) |
| `npm run db:studio` | Explorador visual de la BD |
| `npm run test:smoke` | Prueba E2E contra la API corriendo |

---

## 2. Estructura

```
prisma/
  schema.prisma                  # Modelo de datos (fuente de verdad)
  migrations/…/migration.sql     # DDL SQL generado + CHECK constraints
  seed.ts
src/
  server.ts                      # HTTP + Socket.io + apagado ordenado
  app.ts                         # Middlewares (helmet, cors, logs, JSON)
  routes.ts                      # Montaje de módulos y permisos por rol
  config/env.ts                  # Variables de entorno validadas
  lib/                           # prisma, errores, logger, fechas (hora Colombia), tokens
  middlewares/                   # auth (JWT + roles), manejo de errores
  realtime/                      # Socket.io: auth, salas y catálogo de eventos
  modules/
    auth/        users/          products/ (incluye recetas)
    inventory/   (inventory.ledger.ts = único punto que toca el stock)
    tables/      sales/ (pricing.ts = precios y explosión de recetas)
    shifts/      reports/
```

---

## 3. Decisiones de diseño importantes

| Decisión | Por qué |
|---|---|
| **Dinero en `Int` (COP)**, stock en `Decimal(14,3)`, costo unitario en `Decimal(14,4)` | Nunca usar `float` para plata. 1 L de leche a $4.500 = $4,5/ml, que no cabe en un entero. |
| **El servidor calcula todos los precios** | El celular solo manda `productId` y cantidades. Así nadie puede vender un cappuccino a $1. |
| **Idempotencia con `clientRequestId`** | Si se cae la señal justo después de cobrar y el celular reintenta, no se duplica la venta ni se descuenta dos veces el inventario. |
| **Ledger de inventario inmutable** | `current_stock` solo cambia por `applyStockChanges()`, que siempre deja un registro en `inventory_movements` con el stock resultante. |
| **Bloqueo de filas (`FOR UPDATE`) en orden fijo** | Dos ventas simultáneas que usan café no se pisan ni causan deadlocks. |
| **Cobro de mesa atómico** | Si dos vendedores cobran la misma mesa a la vez, solo uno gana; el otro recibe `409 TABLE_NOT_OPEN`. |
| **Snapshots de nombres y precios** | Ventas y movimientos guardan nombre y precio del momento. Renombrar un producto no altera el histórico. |
| **`base_key` en insumos** | `wh_cafe` y `pos_cafe` comparten `base_key = cafe`, así el traslado bodega→POS no es ambiguo. |
| **Costo promedio ponderado** | Al recibir mercancía a un precio nuevo, el costo unitario se promedia y los márgenes salen reales. |
| **Totales de turno calculados en vivo** | Se calculan desde las ventas (las anuladas no cuentan) y se congelan al cerrar caja. |
| **Fechas en hora Colombia** | `date_key` y reportes usan `America/Bogota`. Una venta a las 11 pm no cae en el día siguiente. |
| **Vendedores no ven costos** | `ingredientCost` y `grossMargin` solo llegan a OWNER, por REST y por socket. |

### Reglas de negocio implementadas
- **Turnos:** un vendedor (EMPLOYEE) **no puede vender sin turno abierto**. Solo hay un turno por vendedor por día. Al cerrar se calcula `expectedCash = base + efectivo cobrado` y la diferencia contra lo contado. Un OWNER puede reabrir turnos. Los OWNER pueden vender sin turno.
- **Cortesías:** `total = 0`, **sí descuentan inventario** y guardan beneficiario, tipo y motivo. El reporte `/reports/courtesies` muestra el valor comercial regalado y el costo real.
- **Inventario negativo:** con `ALLOW_NEGATIVE_STOCK=true` una venta nunca se bloquea porque el conteo esté desfasado; se emite la alerta. Traslados, salidas y ajustes nunca permiten negativos.
- **Recetas:** solo pueden usar insumos del **Punto de Venta** (las ventas descuentan de ahí). Las adiciones (`toppingIds`) también pueden tener receta y se descuentan.
- **Sustitución de leche:** en cada receta, la leche base se marca con `isMilk: true`. Cada producto de la categoría *Leches* tiene `milkInventoryItemId` (ej: `pos_leche_almendras`). Si la venta trae `milkOptionId`, se cobra el recargo y la leche base se descuenta **del insumo de la leche elegida**, en la misma cantidad y con su costo real. Ej: Cappuccino (180 ml de leche entera) + Almendras → descuenta 180 ml de leche de almendras y 0 de leche entera. Un `milkOptionId` que no sea una leche configurada devuelve `400 NOT_A_MILK_OPTION`. Si la bebida no tiene ingrediente `isMilk` (ej: americano), solo se cobra el recargo.
- **Anulaciones:** solo OWNER. `restock: true` reintegra los insumos (si la bebida no se alcanzó a preparar).

---

## 4. API REST — `/api/v1`

Autenticación: `Authorization: Bearer <accessToken>`. El access token dura 15 min. Ante `401 TOKEN_EXPIRED_OR_INVALID`, llama `POST /auth/refresh` y reintenta.

**Formato de error** (decide por `code`, muestra `message`):
```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Stock insuficiente de \"Café en grano\"", "details": {…} } }
```

### Auth
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/auth/login` | público | `{email, password}` → `{accessToken, refreshToken, user}` |
| POST | `/auth/refresh` | público | `{refreshToken}` → nueva sesión (rotación) |
| POST | `/auth/logout` | público | `{refreshToken}` |
| GET | `/auth/me` | todos | Usuario actual |

### Usuarios (OWNER)
`GET /users` · `POST /users` · `PATCH /users/:id` (nombre, email, rol, `isActive`, password)

### Productos y recetas
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/products?category=&active=&updatedSince=` | todos | Catálogo |
| GET | `/products/categories` | todos | Categorías sugeridas |
| GET | `/products/:id` | todos | |
| POST | `/products` | OWNER | Crear |
| PATCH | `/products/:id` | OWNER | Editar |
| PATCH | `/products/:id/active` | OWNER | Interruptor On/Off `{isActive}` |
| GET | `/products/:id/recipe` | todos | Receta con costo estimado |
| PUT | `/products/:id/recipe` | OWNER | Reemplaza la receta `{preparationTimeSeconds, ingredients:[{ingredientId, quantity, isMilk?}]}` |

Para crear una opción de leche: `POST /products {"id":"milk_avena","name":"Leche de avena","category":"Leches","price":2500,"milkInventoryItemId":"pos_leche_avena"}`

### Inventario
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/inventory/items?location=&lowStock=true&updatedSince=` | todos | |
| POST | `/inventory/items` | OWNER | Crear insumo (con `initialStock`) |
| PATCH | `/inventory/items/:id` | OWNER | Datos (no stock) |
| POST | `/inventory/movements/input` | OWNER | Entrada `{itemId, quantity, unitCost?, supplier?}` |
| POST | `/inventory/movements/output` | OWNER | Salida/merma `{itemId, quantity, reason}` |
| POST | `/inventory/movements/transfer` | todos | Bodega→POS `{baseKey, quantity}` |
| POST | `/inventory/movements/adjustment` | OWNER | Conteo físico `{itemId, countedStock, reason}` |
| GET | `/inventory/movements?itemId=&type=&saleId=&from=&to=&page=` | OWNER | Auditoría |

### Mesas (cuentas abiertas)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/tables` | Mesas abiertas con productos y total |
| POST | `/tables` | `{label: "Mesa 4 - Carlos", items?: [...]}` |
| PATCH | `/tables/:id` | Renombrar / notas |
| POST | `/tables/:id/items` | `{items: [...]}` agregar productos |
| PATCH | `/tables/:id/items/:itemId` | Cambiar cantidad / observaciones |
| DELETE | `/tables/:id/items/:itemId` | Quitar producto |
| DELETE | `/tables/:id` | Eliminar mesa sin cobrar |

Para **cobrar** una mesa: `POST /sales` con `openTableId`.

### Ventas
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/sales` | todos | Checkout (201 nueva, 200 reintento idempotente) |
| GET | `/sales?from=&to=&sellerId=&status=&isCourtesy=&page=` | todos | EMPLOYEE solo ve las suyas |
| GET | `/sales/:id` | todos | Acepta UUID o número de ticket (`/sales/1058`) |
| POST | `/sales/:id/refund` | OWNER | `{reason, restock}` |

**Línea de producto** (usada en ventas y mesas):
```json
{ "productId": "6", "quantity": 2, "toppingIds": ["26"], "milkOptionId": "32", "observations": "sin azúcar" }
```
(`"6"` = Cappuccino, `"26"` = Syrope Vainilla, `"32"` = Leche de Almendra. Los IDs son los del catálogo de la app.)

**Venta directa en efectivo con vuelto:**
```json
{
  "clientRequestId": "3f1c9a52-7c1e-4b8e-9d0a-2b6f1e8c4a11",
  "items": [{ "productId": "6", "quantity": 2 }],
  "payments": [{ "method": "CASH", "amount": 20000, "receivedAmount": 50000 }]
}
```
**Cobrar mesa con pago mixto:**
```json
{
  "clientRequestId": "…",
  "openTableId": "…",
  "payments": [
    { "method": "CASH", "amount": 5000 },
    { "method": "TRANSFER", "amount": 12500, "reference": "NEQUI-123" }
  ]
}
```
**Cortesía:**
```json
{
  "clientRequestId": "…",
  "items": [{ "productId": "36", "quantity": 1 }],
  "courtesy": { "beneficiary": "Adalina Fonseca", "type": "ADMINISTRADOR", "notes": "Reunión de socios" }
}
```

### Turnos
| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/shifts/open` | todos | `{startingCash}` |
| GET | `/shifts/current` | todos | `{shift: {... live: {totales, expectedCash}} \| null}` |
| GET | `/shifts?from=&to=&sellerId=&open=` | todos | EMPLOYEE solo los suyos |
| GET | `/shifts/:id` | todos | |
| POST | `/shifts/:id/close` | dueño del turno / OWNER | `{countedCash, notes?}` → faltante/sobrante |
| POST | `/shifts/:id/reopen` | OWNER | |

### Reportes (OWNER) — `?from=yyyy-MM-dd&to=yyyy-MM-dd` (por defecto hoy)
`/reports/sales-summary` · `/reports/top-products` · `/reports/sales-by-seller` · `/reports/sales-by-hour` · `/reports/courtesies` · `/reports/inventory-valuation`

---

## 5. Tiempo real (Socket.io)

Conexión con el mismo access token:
```kotlin
// build.gradle: implementation("io.socket:socket.io-client:2.1.1")
val opts = IO.Options.builder()
    .setAuth(mapOf("token" to accessToken))
    .setTransports(arrayOf(WebSocket.NAME))
    .build()
val socket = IO.socket("https://tu-api.com", opts)

socket.on("sale.created") { args ->
    val envelope = args[0] as JSONObject      // { data: {...}, emittedAt: "..." }
    // upsert en Room
}
socket.on(Socket.EVENT_CONNECT_ERROR) { /* si es TOKEN_EXPIRED_OR_INVALID: refresh y reconectar */ }
socket.connect()
```

| Evento | Payload `data` | Quién lo recibe |
|---|---|---|
| `session.ready` | `{userId, role, recovered}` | el que conecta |
| `product.upserted` | Producto | todos |
| `inventory.updated` | `{items: InventoryItem[]}` | todos |
| `inventory.low_stock` | `{items: InventoryItem[]}` | todos |
| `table.upserted` | Mesa completa con items y `version` | todos |
| `table.closed` | `{id, label, status, version, saleId?}` | todos |
| `sale.created` / `sale.refunded` | Venta (con costos solo para OWNER) | todos |
| `shift.updated` | Turno con totales en vivo | el vendedor del turno + OWNERs |

**Estrategia de sincronización recomendada en Android:**
1. Al abrir la app o **reconectar** el socket: pide por REST lo que cambió (`GET /products?updatedSince=…`, `/inventory/items?updatedSince=…`, `/tables?updatedSince=…`) usando el último `emittedAt` guardado.
2. Mientras esté conectado: aplica los eventos como *upsert* en Room. En mesas, ignora un evento si su `version` es menor a la que ya tienes.
3. Ventas offline: guarda la venta localmente con su `clientRequestId` y reintenta hasta recibir 200/201. La idempotencia garantiza que no se duplica.

---

## 6. Despliegue

- **Railway (recomendado):** *New Project → Deploy from GitHub repo*. Railway detecta el `Dockerfile`, que compila TypeScript, aplica las migraciones pendientes (`prisma migrate deploy`) y arranca la API.
  - Variables: `NODE_ENV=production`, `DATABASE_URL` (Neon con pooler), `DATABASE_URL_UNPOOLED` (Neon directa), `JWT_ACCESS_SECRET` (uno propio de producción), `BUSINESS_TIMEZONE=America/Bogota`, `ALLOW_NEGATIVE_STOCK=true`, `CORS_ORIGINS=*`. `PORT` lo asigna Railway.
  - Health check: `/health`. Región cercana a Neon (US East).
- **Docker propio:** `docker compose up -d --build`.
- Usa **HTTPS** siempre (los tokens viajan en cada petición).
- Una sola instancia: para escalar a varias, agregar `@socket.io/redis-adapter`.

---

## 7. Pendientes / decisiones abiertas
- Pruebas automatizadas con Vitest (unitarias del checkout y del ledger).
- Monitoreo de errores (Sentry).
- Backups automáticos diarios de la BD fuera de Neon (`pg_dump`).
- Recetas para los productos que aún no tienen (sin receta no descuentan inventario ni calculan costo).
- Conteo físico de inventario para corregir el stock importado del celular.

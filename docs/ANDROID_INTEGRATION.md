# Integración Android ↔ Backend Estación Siete

> Documento para el agente/desarrollador Android. Describe **exactamente** cómo
> conectar la app al backend real. El backend ya está construido y probado
> (69 pruebas E2E). No inventes endpoints ni campos: todo está aquí.

---

## 0. Datos de conexión

| Entorno | BASE_URL REST | URL Socket.io |
|---|---|---|
| Pruebas en LAN (PC del desarrollador) | `http://192.168.1.8:3000/api/v1/` | `http://192.168.1.8:3000` |
| Producción (más adelante, HTTPS) | `https://<dominio>/api/v1/` | `https://<dominio>` |

- El celular debe estar en **el mismo Wi-Fi** que el PC.
- Usuarios de prueba (contraseña `Cambiar123*`):
  - `adalina@estacionsiete.co` (OWNER)
  - `glori@estacionsiete.co` (OWNER)
  - `leonel@estacionsiete.co` (EMPLOYEE)
  - `nescibeth@estacionsiete.co` (EMPLOYEE)

---

## 1. Configuración del proyecto Android

### 1.1 `build.gradle.kts` (módulo app)
```kotlin
android {
    buildFeatures { buildConfig = true }
    buildTypes {
        debug {
            buildConfigField("String", "API_BASE_URL", "\"http://192.168.1.8:3000/api/v1/\"")
            buildConfigField("String", "SOCKET_URL", "\"http://192.168.1.8:3000\"")
        }
        release {
            buildConfigField("String", "API_BASE_URL", "\"https://CAMBIAR/api/v1/\"")
            buildConfigField("String", "SOCKET_URL", "\"https://CAMBIAR\"")
        }
    }
}

dependencies {
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-kotlinx-serialization:2.11.0") // NO Gson
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json")  // Android ya trae org.json
    }
}
// Logging: HttpLoggingInterceptor en nivel BODY SOLO si BuildConfig.DEBUG (en release expondría tokens y contraseñas).
```

### 1.2 Permitir HTTP (sin S) SOLO para la IP de pruebas
Android bloquea HTTP plano por defecto. Crear `app/src/debug/res/xml/network_security_config.xml`:
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">192.168.1.8</domain>
    </domain-config>
</network-security-config>
```
Y en `app/src/debug/AndroidManifest.xml`:
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:networkSecurityConfig="@xml/network_security_config"
        tools:targetApi="n" />
</manifest>
```
(En `main/AndroidManifest.xml` también debe estar `INTERNET`.) Release NO lleva esto: producción será HTTPS.

---

## 2. Convenciones de la API

- JSON en camelCase. Fechas ISO-8601 UTC (`"2026-11-16T11:55:22.195Z"`).
- **Dinero:** enteros en pesos COP (`7000` = $7.000). **Stock y cantidades de receta:** números decimales.
- Header en toda petición autenticada: `Authorization: Bearer <accessToken>`.
- **Errores** (siempre este formato). Decidir por `code`, mostrar `message` al usuario:
```json
{ "error": { "code": "SHIFT_NOT_OPEN", "message": "Debes abrir tu turno antes de vender", "details": null } }
```
- `400 VALIDATION_ERROR` trae `details: [{ "path": "items.0.quantity", "message": "..." }]`.

Códigos que la app debe manejar explícitamente:

| code | Qué hacer en la app |
|---|---|
| `TOKEN_EXPIRED_OR_INVALID` (401) | Refrescar token y reintentar (automático, ver §3) |
| `INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_EXPIRED` (401) | Cerrar sesión → pantalla de login |
| `INVALID_CREDENTIALS` (401) | "Correo o contraseña incorrectos" |
| `USER_DISABLED` (403) | Cerrar sesión, mostrar mensaje |
| `FORBIDDEN` (403) | Ocultar la función a ese rol |
| `SHIFT_NOT_OPEN` (409) | Llevar a la pantalla "Abrir turno" |
| `SHIFT_ALREADY_OPEN` / `PREVIOUS_SHIFT_OPEN` / `SHIFT_ALREADY_CLOSED_TODAY` (409) | Mostrar `message` |
| `PRODUCT_INACTIVE` (400) | Refrescar catálogo, quitar producto del carrito |
| `PAYMENT_MISMATCH` / `INSUFFICIENT_CASH` (400) | Error en el formulario de pago |
| `TABLE_NOT_OPEN` (409) | La mesa ya fue cobrada/eliminada por otro: refrescar mesas |
| `TABLE_LABEL_IN_USE` (409) | "Ya hay una mesa abierta con ese nombre" |
| `INSUFFICIENT_STOCK` (409) | Mostrar `message` (traslados/salidas) |

---

## 3. Autenticación

### Endpoints
```
POST auth/login    { "email": "...", "password": "..." }
POST auth/refresh  { "refreshToken": "..." }
POST auth/logout   { "refreshToken": "..." }      -> 204
GET  auth/me
```
Respuesta de login y refresh:
```json
{
  "accessToken": "eyJ...",
  "accessTokenExpiresIn": 900,
  "refreshToken": "kq3...",
  "user": { "id": "uuid", "name": "Leonel", "email": "leonel@...", "role": "EMPLOYEE", "isActive": true, "createdAt": "..." }
}
```

### Reglas
- **Usar DTOs propios de red** (`UserDto`, `AuthResponse`...), separados de los modelos locales de la app. El JSON del servidor NO trae `password` y `role` solo puede ser `OWNER` o `EMPLOYEE`.
- **Serialización:** el proyecto ya usa kotlinx.serialization (`converter-kotlinx-serialization`). Usarla con `Json { ignoreUnknownKeys = true; explicitNulls = false }`. No mezclar con Gson: Gson ignora los valores por defecto de Kotlin y deja `null` en campos no nulos.
- Guardar `accessToken`, `refreshToken` y `user` en almacenamiento privado de la app (SharedPreferences `MODE_PRIVATE` o DataStore).
- El access token dura **15 min**. El refresh token dura 30 días y **rota**: cada refresh devuelve uno NUEVO y el viejo deja de servir. **Siempre guardar el nuevo.**
- Si se usa un refresh token viejo, el servidor cierra TODAS las sesiones del usuario (protección anti-robo). Por eso el refresh debe estar **sincronizado** (un solo refresh a la vez).
- `role`: `OWNER` = administrador, `EMPLOYEE` = vendedor. Usarlo para mostrar/ocultar módulos (reportes, inventario de bodega, usuarios, anulaciones).

### Implementación OkHttp recomendada
```kotlin
class AuthInterceptor(private val store: TokenStore) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = store.accessToken ?: return chain.proceed(chain.request())
        return chain.proceed(chain.request().newBuilder().header("Authorization", "Bearer $token").build())
    }
}

/** Se ejecuta automáticamente ante un 401. Un solo refresh a la vez. */
class TokenAuthenticator(
    private val store: TokenStore,
    private val refreshApi: AuthApi,          // Retrofit SIN este authenticator (evita bucles)
    private val onSessionExpired: () -> Unit,
) : Authenticator {
    private val lock = Any()
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.request.url.encodedPath.endsWith("/auth/refresh")) return null
        if (responseCount(response) >= 2) return null
        synchronized(lock) {
            val sent = response.request.header("Authorization")?.removePrefix("Bearer ")
            // Otro hilo ya refrescó mientras esperábamos
            if (store.accessToken != null && store.accessToken != sent) {
                return response.request.withToken(store.accessToken!!)
            }
            val rt = store.refreshToken ?: run { onSessionExpired(); return null }
            val res = try {
                refreshApi.refreshBlocking(RefreshRequest(rt)).execute()
            } catch (e: IOException) {
                return null // Sin red: NO cerrar sesión. La petición falla y se reintenta luego.
            }
            // Solo 401/403 significan sesión inválida. Un 500/429/timeout NO debe sacar al vendedor.
            if (res.code() == 401 || res.code() == 403) { store.clear(); onSessionExpired(); return null }
            val body = res.body() ?: return null
            store.save(body.accessToken, body.refreshToken, body.user)
            return response.request.withToken(body.accessToken)
        }
    }
    private fun Request.withToken(t: String) = newBuilder().header("Authorization", "Bearer $t").build()
    private fun responseCount(r: Response): Int { var c = 1; var p = r.priorResponse; while (p != null) { c++; p = p.priorResponse }; return c }
}
```

---

## 4. Endpoints por módulo (rutas relativas a BASE_URL)

### 4.1 Productos (lectura: todos; escritura: OWNER)
```
GET   products?category=&active=true&updatedSince=<ISO>
GET   products/{id}
GET   products/categories
POST  products                       (OWNER)
PATCH products/{id}                  (OWNER)
PATCH products/{id}/active  {"isActive": false}   (OWNER) — interruptor On/Off
GET   products/{id}/recipe
PUT   products/{id}/recipe           (OWNER)
```
Producto:
```json
{ "id": "cappuccino_9oz", "name": "Cappuccino Clásico 9oz", "category": "Bebidas Calientes",
  "price": 7000, "isActive": true, "description": null, "preparationTimeSeconds": 150,
  "milkInventoryItemId": null, "recipeId": "uuid", "createdAt": "...", "updatedAt": "..." }
```
- Productos de categoría **"Adiciones"** se envían en `toppingIds`.
- Productos de categoría **"Leches"** (tienen `milkInventoryItemId`) se envían en `milkOptionId`. Reemplazan la leche de la receta y suman su `price` como recargo.
- Los IDs de producto son strings legibles (`americano_7oz`, `brownie`), no números.

### 4.2 Turnos
```
POST shifts/open            {"startingCash": 50000}         -> 201
GET  shifts/current         -> {"shift": {...} | null}
POST shifts/{id}/close      {"countedCash": 66000, "notes": "..."}
GET  shifts?from=yyyy-MM-dd&to=yyyy-MM-dd
POST shifts/{id}/reopen     (OWNER)
```
Turno:
```json
{ "id": "uuid", "sellerId": "uuid", "sellerName": "Leonel", "dateKey": "2026-11-16",
  "openedAt": "...", "closedAt": null, "startingCash": 50000, "isOpen": true,
  "totalSalesCollected": 0, "totalTickets": 0, "cashCollected": null,
  "expectedCash": null, "countedCash": null, "cashDifference": null, "closingNotes": null,
  "live": { "totalSalesCollected": 26500, "totalTickets": 2, "courtesyTickets": 0,
            "byMethod": { "CASH": 17000, "TRANSFER": 9500, "CARD_TERMINAL": 0 },
            "cashCollected": 17000, "expectedCash": 67000 } }
```
- **Un EMPLOYEE no puede vender sin turno abierto.** Al iniciar sesión: `GET shifts/current`. Si `shift == null`, mostrar "Abrir turno".
- Mientras está abierto, mostrar los valores de `live`. Al cerrar, el servidor congela los totales y calcula `cashDifference` (negativo = faltante).

### 4.3 Ventas / Checkout
```
POST sales          -> 201 (nueva) o 200 (reintento ya procesado). Ambos = éxito.
GET  sales?from=&to=&page=1&pageSize=50     -> {data, page, pageSize, total}
GET  sales/{id o número de ticket}
POST sales/{id}/refund  {"reason": "...", "restock": true}   (OWNER)
```
Línea de producto (mismo formato en ventas y mesas):
```json
{ "productId": "cappuccino_9oz", "quantity": 2, "toppingIds": ["add_vainilla"],
  "milkOptionId": "milk_almendras", "observations": "sin azúcar" }
```
Cuerpos de checkout:
```jsonc
// Venta en mostrador, efectivo con vuelto
{ "clientRequestId": "<UUID>", "items": [ ...líneas ],
  "payments": [ { "method": "CASH", "amount": 17000, "receivedAmount": 20000 } ] }

// Cobrar una mesa (los precios los toma de la mesa)
{ "clientRequestId": "<UUID>", "openTableId": "<uuid mesa>",
  "payments": [ { "method": "CARD_TERMINAL", "amount": 17500, "reference": "DAT-998" } ] }

// Pago mixto
"payments": [ { "method": "CASH", "amount": 5000 }, { "method": "TRANSFER", "amount": 12500, "reference": "NEQUI-123" } ]

// Cortesía (total $0, sí descuenta inventario). NO enviar payments.
{ "clientRequestId": "<UUID>", "items": [ ... ],
  "courtesy": { "beneficiary": "Adalina Fonseca", "type": "ADMINISTRADOR", "notes": "Reunión de socios" } }
```
- `method`: `CASH | TRANSFER | CARD_TERMINAL`. `courtesy.type`: `ADMINISTRADOR | VENDEDOR | INVITADO`.
- La suma de `amount` debe ser **exactamente** el total. El vuelto lo calcula el servidor (`changeAmount`).
- **La app NO envía precios.** El servidor los calcula. Para mostrar el total en pantalla antes de cobrar, calcular localmente con los precios del catálogo; si no coincide, el servidor responde `PAYMENT_MISMATCH`.

**`clientRequestId` (crítico):**
1. Generar `UUID.randomUUID()` **una vez**, cuando el usuario presiona "Cobrar".
2. Guardarlo con la venta pendiente (Room) ANTES de enviar.
3. Si falla la red o hay timeout, reintentar con **el mismo** UUID. El servidor nunca duplica la venta.
4. Solo generar uno nuevo para una venta nueva.

Respuesta de venta:
```json
{ "id": "uuid", "ticketNumber": 1000, "ticketId": "1000", "clientRequestId": "...",
  "createdAt": "...", "subtotal": 17000, "total": 17000, "status": "APPROVED",
  "sellerId": "uuid", "sellerName": "Leonel", "shiftId": "uuid", "openTableId": null, "tableLabel": null,
  "isCourtesy": false, "courtesyBeneficiary": null, "courtesyType": null, "courtesyNotes": null,
  "items": [ { "id": "uuid", "productId": "cappuccino_9oz", "productName": "Cappuccino Clásico 9oz",
               "quantity": 2, "unitPrice": 8500, "subtotal": 17000,
               "modifiers": [ { "productId": "add_vainilla", "name": "Jarabe de vainilla", "price": 1500, "kind": "TOPPING" } ],
               "observations": "sin azúcar", "saleMode": "INDIVIDUAL", "tableLabel": null } ],
  "payments": [ { "id": "uuid", "method": "CASH", "amount": 17000, "receivedAmount": 20000, "changeAmount": 3000, "reference": null } ] }
```
(Para OWNER también vienen `ingredientCost` y `grossMargin`, en la venta y en cada item.)

### 4.4 Mesas
```
GET    tables                         -> mesas abiertas con items y total
POST   tables  {"label": "Mesa 4 - Carlos", "items": [ ...líneas opcionales ]}
PATCH  tables/{id}  {"label": "...", "notes": "..."}
POST   tables/{id}/items  {"items": [ ...líneas ]}
PATCH  tables/{id}/items/{itemId}  {"quantity": 3, "observations": "..."}
DELETE tables/{id}/items/{itemId}
DELETE tables/{id}                    -> elimina sin cobrar
```
Mesa:
```json
{ "id": "uuid", "label": "Mesa 4 - Carlos", "status": "OPEN", "notes": null, "version": 3,
  "openedById": "uuid", "openedByName": "Leonel", "total": 17500,
  "items": [ { "id": "uuid", "productId": "...", "productName": "...", "quantity": 1, "unitPrice": 9500,
               "subtotal": 9500, "modifiers": [], "observations": null, "sellerId": "uuid", "sellerName": "Glori Fonseca" } ] }
```
Todas las operaciones de mesa devuelven la mesa completa actualizada: reemplazarla en Room.

### 4.5 Inventario
```
GET  inventory/items?location=POINT_OF_SALE|WAREHOUSE&lowStock=true&updatedSince=
POST inventory/movements/transfer    {"baseKey": "cafe", "quantity": 500}         (todos)
POST inventory/movements/input       {"itemId": "wh_cafe", "quantity": 5000, "unitCost": 58, "supplier": "..."}  (OWNER)
POST inventory/movements/output      {"itemId": "pos_brownie", "quantity": 1, "reason": "Se cayó"}             (OWNER)
POST inventory/movements/adjustment  {"itemId": "pos_hielo", "countedStock": 2000, "reason": "Conteo"}         (OWNER)
GET  inventory/movements?itemId=&type=&from=&to=&page=                                                        (OWNER)
```
- IDs: `pos_<baseKey>` (punto de venta) y `wh_<baseKey>` (bodega). El traslado usa `baseKey`.
- El stock NUNCA se edita directo: solo con movimientos.

### 4.6 Reportes (OWNER) — `?from=yyyy-MM-dd&to=yyyy-MM-dd` (por defecto hoy)
```
GET reports/sales-summary      GET reports/top-products     GET reports/sales-by-seller
GET reports/sales-by-hour      GET reports/courtesies       GET reports/inventory-valuation
```

---

## 5. Tiempo real (Socket.io)

```kotlin
object RealtimeClient {
    private var socket: Socket? = null

    fun connect(token: String, onEvent: (String, JSONObject) -> Unit) {
        disconnect()
        val opts = IO.Options.builder()
            .setAuth(mapOf("token" to token))
            .setTransports(arrayOf(WebSocket.NAME))
            .setReconnection(true)
            .build()
        socket = IO.socket(BuildConfig.SOCKET_URL, opts).apply {
            listOf(
                "session.ready", "product.upserted", "inventory.updated", "inventory.low_stock",
                "table.upserted", "table.closed", "sale.created", "sale.refunded", "shift.updated",
            ).forEach { ev -> on(ev) { args -> onEvent(ev, args[0] as JSONObject) } }
            on(Socket.EVENT_CONNECT_ERROR) { args ->
                // "TOKEN_EXPIRED_OR_INVALID": refrescar token y llamar connect() de nuevo con el nuevo token
            }
            connect()
        }
    }
    fun disconnect() { socket?.off(); socket?.disconnect(); socket = null }
}
```
Cada evento llega como `{ "data": {...}, "emittedAt": "ISO" }`.

| Evento | `data` | Acción en Room |
|---|---|---|
| `session.ready` | `{userId, role, recovered}` | Si `recovered == false`: sincronización completa (ver abajo) |
| `product.upserted` | Producto | upsert |
| `inventory.updated` | `{items: [...]}` | upsert de cada item |
| `inventory.low_stock` | `{items: [...]}` | notificación/badge |
| `table.upserted` | Mesa completa | upsert **solo si** `version` > la local |
| `table.closed` | `{id, label, status, version, saleId?}` | quitar de mesas abiertas |
| `sale.created` / `sale.refunded` | Venta | upsert en historial |
| `shift.updated` | Turno con `live` | actualizar pantalla de caja |

**Estrategia de sincronización:**
1. Conectar el socket después del login (y al volver a primer plano).
2. En `session.ready` con `recovered == false`: `GET products`, `GET inventory/items`, `GET tables`, `GET shifts/current` y reemplazar caché local. Guardar `emittedAt`.
3. Mientras está conectado, aplicar eventos (fuente de verdad = servidor).
4. Al refrescar el access token (cada ~15 min), **reconectar el socket con el token nuevo**.
5. Al cerrar sesión: `RealtimeClient.disconnect()` + `POST auth/logout`.

---

## 6. Orden de implementación sugerido (probar cada paso en el celular)

1. **Conexión:** `GET {API_BASE_URL}health` (= `/api/v1/health`) o `GET {SOCKET_URL}/health` → `{"status":"ok","db":"up"}`. Ambas rutas son públicas (sin token). Mostrarlo en una pantalla de diagnóstico.
2. **Login** con TokenStore + Interceptor + Authenticator. Navegar según `role`.
3. **Catálogo** desde `GET products`, reemplazando la fuente local. Probar el interruptor On/Off con un OWNER.
4. **Turno:** `shifts/current` → abrir turno → mostrar caja en vivo.
5. **Checkout mostrador** con `clientRequestId` + manejo de errores.
6. **Socket.io:** dos dispositivos (celular + emulador). Vender en uno y ver el turno/inventario actualizarse en el otro.
7. **Mesas** compartidas entre dispositivos.
8. **Cortesías, inventario, reportes, anulaciones** (pantallas de OWNER).
9. **Cierre de caja.**

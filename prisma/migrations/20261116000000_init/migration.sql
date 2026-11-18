-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "InventoryItemType" AS ENUM ('BASE_INGREDIENT', 'FINISHED_PRODUCT');

-- CreateEnum
CREATE TYPE "InventoryLocation" AS ENUM ('POINT_OF_SALE', 'WAREHOUSE');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('INPUT', 'OUTPUT', 'TRANSFER_WH_TO_POS', 'MANUAL_ADJUSTMENT', 'SALE_CONSUMPTION', 'SALE_REVERSAL');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'CARD_TERMINAL', 'COURTESY');

-- CreateEnum
CREATE TYPE "CourtesyType" AS ENUM ('ADMINISTRADOR', 'VENDEDOR', 'INVITADO');

-- CreateEnum
CREATE TYPE "SaleMode" AS ENUM ('INDIVIDUAL', 'TABLE_GROUP');

-- CreateEnum
CREATE TYPE "OpenTableStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EMPLOYEE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "price" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "preparation_time_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" VARCHAR(64) NOT NULL,
    "base_key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "InventoryItemType" NOT NULL,
    "location" "InventoryLocation" NOT NULL,
    "current_stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "minimum_stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit" VARCHAR(16) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "supplier" VARCHAR(120),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "MovementType" NOT NULL,
    "inventory_item_id" VARCHAR(64) NOT NULL,
    "item_name" VARCHAR(120) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "stock_after" DECIMAL(14,3) NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "unit_cost" DECIMAL(14,4) NOT NULL,
    "origin_location" "InventoryLocation",
    "destination_location" "InventoryLocation",
    "reason" TEXT,
    "user_id" UUID,
    "user_name" VARCHAR(120),
    "sale_id" UUID,
    "transfer_group_id" UUID,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "preparation_time_seconds" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_ingredients" (
    "id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "inventory_item_id" VARCHAR(64) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,

    CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_tables" (
    "id" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "active_label_key" VARCHAR(60),
    "status" "OpenTableStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "opened_by_id" UUID NOT NULL,
    "opened_by_name" VARCHAR(120) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "open_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_table_items" (
    "id" UUID NOT NULL,
    "open_table_id" UUID NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "product_name" VARCHAR(120) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "observations" TEXT,
    "seller_id" UUID NOT NULL,
    "seller_name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "open_table_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "ticket_number" SERIAL NOT NULL,
    "client_request_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'APPROVED',
    "seller_id" UUID NOT NULL,
    "seller_name" VARCHAR(120) NOT NULL,
    "shift_id" UUID,
    "open_table_id" UUID,
    "table_label" VARCHAR(60),
    "ingredient_cost" INTEGER NOT NULL DEFAULT 0,
    "gross_margin" INTEGER NOT NULL DEFAULT 0,
    "is_courtesy" BOOLEAN NOT NULL DEFAULT false,
    "courtesy_beneficiary" VARCHAR(120),
    "courtesy_type" "CourtesyType",
    "courtesy_notes" TEXT,
    "refunded_at" TIMESTAMPTZ(3),
    "refunded_by_id" UUID,
    "refund_reason" TEXT,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" VARCHAR(64) NOT NULL,
    "product_name" VARCHAR(120) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "observations" TEXT,
    "sale_mode" "SaleMode" NOT NULL DEFAULT 'INDIVIDUAL',
    "table_label" VARCHAR(60),
    "ingredient_cost" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" VARCHAR(80),
    "received_amount" INTEGER,
    "change_amount" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_shifts" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "seller_name" VARCHAR(120) NOT NULL,
    "date_key" VARCHAR(10) NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "starting_cash" INTEGER NOT NULL,
    "total_sales_collected" INTEGER NOT NULL DEFAULT 0,
    "total_tickets" INTEGER NOT NULL DEFAULT 0,
    "cash_collected" INTEGER,
    "expected_cash" INTEGER,
    "counted_cash" INTEGER,
    "cash_difference" INTEGER,
    "closing_notes" TEXT,

    CONSTRAINT "seller_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "products_updated_at_idx" ON "products"("updated_at");

-- CreateIndex
CREATE INDEX "inventory_items_location_idx" ON "inventory_items"("location");

-- CreateIndex
CREATE INDEX "inventory_items_updated_at_idx" ON "inventory_items"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_base_key_location_key" ON "inventory_items"("base_key", "location");

-- CreateIndex
CREATE INDEX "inventory_movements_inventory_item_id_created_at_idx" ON "inventory_movements"("inventory_item_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_type_created_at_idx" ON "inventory_movements"("type", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_sale_id_idx" ON "inventory_movements"("sale_id");

-- CreateIndex
CREATE INDEX "inventory_movements_created_at_idx" ON "inventory_movements"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_product_id_key" ON "recipes"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_ingredients_recipe_id_inventory_item_id_key" ON "recipe_ingredients"("recipe_id", "inventory_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "open_tables_active_label_key_key" ON "open_tables"("active_label_key");

-- CreateIndex
CREATE INDEX "open_tables_status_idx" ON "open_tables"("status");

-- CreateIndex
CREATE INDEX "open_table_items_open_table_id_idx" ON "open_table_items"("open_table_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_ticket_number_key" ON "sales"("ticket_number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_client_request_id_key" ON "sales"("client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_open_table_id_key" ON "sales"("open_table_id");

-- CreateIndex
CREATE INDEX "sales_created_at_idx" ON "sales"("created_at");

-- CreateIndex
CREATE INDEX "sales_seller_id_created_at_idx" ON "sales"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_shift_id_idx" ON "sales"("shift_id");

-- CreateIndex
CREATE INDEX "sales_status_created_at_idx" ON "sales"("status", "created_at");

-- CreateIndex
CREATE INDEX "sales_is_courtesy_created_at_idx" ON "sales"("is_courtesy", "created_at");

-- CreateIndex
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE INDEX "sale_payments_sale_id_idx" ON "sale_payments"("sale_id");

-- CreateIndex
CREATE INDEX "sale_payments_method_idx" ON "sale_payments"("method");

-- CreateIndex
CREATE INDEX "seller_shifts_date_key_idx" ON "seller_shifts"("date_key");

-- CreateIndex
CREATE UNIQUE INDEX "seller_shifts_seller_id_date_key_key" ON "seller_shifts"("seller_id", "date_key");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_tables" ADD CONSTRAINT "open_tables_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_table_items" ADD CONSTRAINT "open_table_items_open_table_id_fkey" FOREIGN KEY ("open_table_id") REFERENCES "open_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_table_items" ADD CONSTRAINT "open_table_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_table_items" ADD CONSTRAINT "open_table_items_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_refunded_by_id_fkey" FOREIGN KEY ("refunded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "seller_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_open_table_id_fkey" FOREIGN KEY ("open_table_id") REFERENCES "open_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_shifts" ADD CONSTRAINT "seller_shifts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
--  Reglas de integridad adicionales (no expresables en Prisma)
-- =============================================================================

-- Los tickets empiezan en 1000 para que se vean como "1058" y no "#3"
ALTER SEQUENCE "sales_ticket_number_seq" RESTART WITH 1000;

ALTER TABLE "products"          ADD CONSTRAINT "products_price_chk"              CHECK ("price" >= 0);
ALTER TABLE "products"          ADD CONSTRAINT "products_prep_time_chk"          CHECK ("preparation_time_seconds" >= 0);
ALTER TABLE "inventory_items"   ADD CONSTRAINT "inventory_items_min_stock_chk"   CHECK ("minimum_stock" >= 0);
ALTER TABLE "inventory_items"   ADD CONSTRAINT "inventory_items_unit_cost_chk"   CHECK ("unit_cost" >= 0);
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_qty_chk"     CHECK ("quantity" > 0);
ALTER TABLE "open_table_items"  ADD CONSTRAINT "open_table_items_qty_chk"        CHECK ("quantity" > 0 AND "unit_price" >= 0);
ALTER TABLE "sales"             ADD CONSTRAINT "sales_amounts_chk"               CHECK ("subtotal" >= 0 AND "total" >= 0);
ALTER TABLE "sales"             ADD CONSTRAINT "sales_courtesy_chk"              CHECK (("is_courtesy" = false) OR ("total" = 0 AND "courtesy_beneficiary" IS NOT NULL));
ALTER TABLE "sale_items"        ADD CONSTRAINT "sale_items_qty_chk"              CHECK ("quantity" > 0 AND "unit_price" >= 0);
ALTER TABLE "sale_payments"     ADD CONSTRAINT "sale_payments_amount_chk"        CHECK ("amount" >= 0);
ALTER TABLE "seller_shifts"     ADD CONSTRAINT "seller_shifts_starting_cash_chk" CHECK ("starting_cash" >= 0);

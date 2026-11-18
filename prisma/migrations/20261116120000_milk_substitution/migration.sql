-- Sustitución de leche: la leche alternativa reemplaza a la leche base de la receta
-- AlterTable
ALTER TABLE "products" ADD COLUMN     "milk_inventory_item_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "recipe_ingredients" ADD COLUMN     "is_milk" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_milk_inventory_item_id_fkey" FOREIGN KEY ("milk_inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


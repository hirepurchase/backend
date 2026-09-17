-- Where staff work. Collected so cluster agents can be grouped with agents near
-- them, and so stock goes to whoever is closest to the customer.
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "area" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "district" TEXT;

-- Stock movement history.
--
-- Assignment lived in a single mutable column on InventoryItem, so each
-- transfer overwrote the last and "who held this phone in July" could only be
-- answered by reading audit-log payloads. Cluster agents moving stock between
-- their agents makes that a routine question.
CREATE TABLE IF NOT EXISTS "InventoryTransfer" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "fromAgentId" TEXT,
    "toAgentId" TEXT,
    "transferredById" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InventoryTransfer_inventoryItemId_createdAt_idx" ON "InventoryTransfer"("inventoryItemId", "createdAt");
CREATE INDEX IF NOT EXISTS "InventoryTransfer_toAgentId_createdAt_idx" ON "InventoryTransfer"("toAgentId", "createdAt");
CREATE INDEX IF NOT EXISTS "InventoryTransfer_fromAgentId_createdAt_idx" ON "InventoryTransfer"("fromAgentId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryTransfer_inventoryItemId_fkey') THEN
    ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_inventoryItemId_fkey"
      FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryTransfer_fromAgentId_fkey') THEN
    ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_fromAgentId_fkey"
      FOREIGN KEY ("fromAgentId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryTransfer_toAgentId_fkey') THEN
    ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_toAgentId_fkey"
      FOREIGN KEY ("toAgentId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryTransfer_transferredById_fkey') THEN
    ALTER TABLE "InventoryTransfer" ADD CONSTRAINT "InventoryTransfer_transferredById_fkey"
      FOREIGN KEY ("transferredById") REFERENCES "AdminUser"("id") ON UPDATE CASCADE;
  END IF;
END $$;

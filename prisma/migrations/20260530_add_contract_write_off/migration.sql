-- Add write-off fields to HirePurchaseContract
ALTER TABLE "HirePurchaseContract"
  ADD COLUMN IF NOT EXISTS "writeOffReason"  TEXT,
  ADD COLUMN IF NOT EXISTS "writtenOffAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "writtenOffById"  TEXT;

-- Foreign key to AdminUser
ALTER TABLE "HirePurchaseContract"
  ADD CONSTRAINT IF NOT EXISTS "HirePurchaseContract_writtenOffById_fkey"
  FOREIGN KEY ("writtenOffById") REFERENCES "AdminUser"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

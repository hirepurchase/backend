-- Add write-off fields to HirePurchaseContract
ALTER TABLE "HirePurchaseContract"
  ADD COLUMN IF NOT EXISTS "writeOffReason"  TEXT,
  ADD COLUMN IF NOT EXISTS "writtenOffAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "writtenOffById"  TEXT;

-- Foreign key to AdminUser (only add if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'HirePurchaseContract_writtenOffById_fkey'
    AND table_name = 'HirePurchaseContract'
  ) THEN
    ALTER TABLE "HirePurchaseContract"
      ADD CONSTRAINT "HirePurchaseContract_writtenOffById_fkey"
      FOREIGN KEY ("writtenOffById") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Fix missing UUID columns that were supposed to be added in phase4_uuid_relations
-- Run this in Supabase SQL Editor if contracts/payments are returning 500 errors

-- Step 1: Add id_uuid to Customer (populate from existing id which is already a UUID string)
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "id_uuid" UUID;
UPDATE "Customer" SET "id_uuid" = "id"::uuid WHERE "id_uuid" IS NULL;
ALTER TABLE "Customer" ALTER COLUMN "id_uuid" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_id_uuid_key" ON "Customer"("id_uuid");

-- Step 2: Add customerId_uuid to HirePurchaseContract
ALTER TABLE "HirePurchaseContract" ADD COLUMN IF NOT EXISTS "customerId_uuid" UUID;
UPDATE "HirePurchaseContract" hpc
  SET "customerId_uuid" = c."id_uuid"
  FROM "Customer" c
  WHERE hpc."customerId" = c."id"
    AND hpc."customerId_uuid" IS NULL;
ALTER TABLE "HirePurchaseContract" ALTER COLUMN "customerId_uuid" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "HirePurchaseContract_customerId_uuid_status_idx" ON "HirePurchaseContract"("customerId_uuid", "status");

-- Add FK constraint for customerId_uuid -> Customer.id_uuid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'HirePurchaseContract_customerId_uuid_fkey'
  ) THEN
    ALTER TABLE "HirePurchaseContract"
      ADD CONSTRAINT "HirePurchaseContract_customerId_uuid_fkey"
      FOREIGN KEY ("customerId_uuid") REFERENCES "Customer"("id_uuid")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 3: Add customerId_uuid to PaymentTransaction
ALTER TABLE "PaymentTransaction" ADD COLUMN IF NOT EXISTS "customerId_uuid" UUID;
UPDATE "PaymentTransaction" pt
  SET "customerId_uuid" = c."id_uuid"
  FROM "Customer" c
  WHERE pt."customerId" = c."id"
    AND pt."customerId_uuid" IS NULL;
ALTER TABLE "PaymentTransaction" ALTER COLUMN "customerId_uuid" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "PaymentTransaction_customerId_uuid_createdAt_idx" ON "PaymentTransaction"("customerId_uuid", "createdAt");

-- Add FK constraint for PaymentTransaction.customerId_uuid -> Customer.id_uuid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PaymentTransaction_customerId_uuid_fkey'
  ) THEN
    ALTER TABLE "PaymentTransaction"
      ADD CONSTRAINT "PaymentTransaction_customerId_uuid_fkey"
      FOREIGN KEY ("customerId_uuid") REFERENCES "Customer"("id_uuid")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Step 4: Drop old text customerId columns (only after confirming the above worked)
-- Uncomment these lines ONLY after verifying the UUID columns are populated correctly:
-- ALTER TABLE "HirePurchaseContract" DROP COLUMN IF EXISTS "customerId";
-- ALTER TABLE "PaymentTransaction" DROP COLUMN IF EXISTS "customerId";

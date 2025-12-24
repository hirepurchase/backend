-- Migration: Add hubtelPreapprovalId to HirePurchaseContract
-- This allows contracts to link to their Hubtel preapproval records

-- Add the hubtelPreapprovalId column (nullable since existing contracts won't have it)
ALTER TABLE "HirePurchaseContract"
ADD COLUMN IF NOT EXISTS "hubtelPreapprovalId" TEXT;

-- Add foreign key constraint to link to HubtelPreapproval table
ALTER TABLE "HirePurchaseContract"
ADD CONSTRAINT "HirePurchaseContract_hubtelPreapprovalId_fkey"
FOREIGN KEY ("hubtelPreapprovalId")
REFERENCES "HubtelPreapproval"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS "HirePurchaseContract_hubtelPreapprovalId_idx"
ON "HirePurchaseContract"("hubtelPreapprovalId");

-- Verify the changes
SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'HirePurchaseContract'
AND column_name = 'hubtelPreapprovalId';

-- Show success message
DO $$
BEGIN
    RAISE NOTICE 'Migration completed successfully!';
    RAISE NOTICE 'Added hubtelPreapprovalId column to HirePurchaseContract table';
    RAISE NOTICE 'Added foreign key constraint to HubtelPreapproval table';
    RAISE NOTICE 'Created index for improved query performance';
END $$;

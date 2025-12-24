-- Rollback Migration: Remove hubtelPreapprovalId from HirePurchaseContract
-- Use this script ONLY if you need to undo the migration

-- Drop the index
DROP INDEX IF EXISTS "HirePurchaseContract_hubtelPreapprovalId_idx";

-- Drop the foreign key constraint
ALTER TABLE "HirePurchaseContract"
DROP CONSTRAINT IF EXISTS "HirePurchaseContract_hubtelPreapprovalId_fkey";

-- Drop the column
ALTER TABLE "HirePurchaseContract"
DROP COLUMN IF EXISTS "hubtelPreapprovalId";

-- Verify the rollback
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
    RAISE NOTICE 'Rollback completed successfully!';
    RAISE NOTICE 'Removed hubtelPreapprovalId column from HirePurchaseContract table';
    RAISE NOTICE 'Removed foreign key constraint and index';
END $$;

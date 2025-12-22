-- SQL Script to add lockStatus and registeredUnder fields to InventoryItem table
-- Run this in Supabase SQL Editor if Prisma migration is not working

-- Add lockStatus column (optional, defaults to 'UNLOCKED')
ALTER TABLE "InventoryItem"
ADD COLUMN IF NOT EXISTS "lockStatus" TEXT DEFAULT 'UNLOCKED';

-- Add registeredUnder column (optional, no default)
ALTER TABLE "InventoryItem"
ADD COLUMN IF NOT EXISTS "registeredUnder" TEXT;

-- Add comments to document the columns
COMMENT ON COLUMN "InventoryItem"."lockStatus" IS 'Device lock status: LOCKED or UNLOCKED';
COMMENT ON COLUMN "InventoryItem"."registeredUnder" IS 'Name of person or entity the device is registered to (optional)';

-- Verify the columns were added successfully
SELECT
    column_name,
    data_type,
    column_default,
    is_nullable
FROM
    information_schema.columns
WHERE
    table_name = 'InventoryItem'
    AND column_name IN ('lockStatus', 'registeredUnder')
ORDER BY
    ordinal_position;

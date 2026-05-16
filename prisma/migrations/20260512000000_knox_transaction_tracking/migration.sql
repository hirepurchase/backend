-- Add Knox transaction tracking fields to ManagedDevice
ALTER TABLE "ManagedDevice" ADD COLUMN IF NOT EXISTS "lastKnoxAction" TEXT;
ALTER TABLE "ManagedDevice" ADD COLUMN IF NOT EXISTS "lastTransactionId" TEXT;

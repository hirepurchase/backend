-- Make contractId and customerId_uuid optional on ManagedDevice
-- This allows manual enrollment without a contract, to be linked later.

ALTER TABLE "ManagedDevice" ALTER COLUMN "contractId" DROP NOT NULL;
ALTER TABLE "ManagedDevice" ALTER COLUMN "customerId_uuid" DROP NOT NULL;

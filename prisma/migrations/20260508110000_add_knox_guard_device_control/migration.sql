-- CreateTable
CREATE TABLE "ManagedDevice" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "inventoryItemId" TEXT,
    "customerId_uuid" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'KNOX_GUARD',
    "deviceUid" TEXT NOT NULL,
    "deviceUidType" TEXT NOT NULL DEFAULT 'SERIAL_NUMBER',
    "approveId" TEXT NOT NULL,
    "knoxObjectId" TEXT,
    "knoxTenantDomain" TEXT,
    "knoxStatus" TEXT,
    "enrollmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "desiredState" TEXT NOT NULL DEFAULT 'UNLOCKED',
    "actualState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLockedAt" TIMESTAMP(3),
    "lastUnlockedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedDeviceCommand" (
    "id" TEXT NOT NULL,
    "managedDeviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "payload" TEXT,
    "response" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedDeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDevice_contractId_key" ON "ManagedDevice"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDevice_inventoryItemId_key" ON "ManagedDevice"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDevice_approveId_key" ON "ManagedDevice"("approveId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDevice_knoxObjectId_key" ON "ManagedDevice"("knoxObjectId");

-- CreateIndex
CREATE INDEX "ManagedDevice_customerId_uuid_createdAt_idx" ON "ManagedDevice"("customerId_uuid", "createdAt");

-- CreateIndex
CREATE INDEX "ManagedDevice_approveId_deviceUid_idx" ON "ManagedDevice"("approveId", "deviceUid");

-- CreateIndex
CREATE INDEX "ManagedDevice_desiredState_actualState_isActive_idx" ON "ManagedDevice"("desiredState", "actualState", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedDeviceCommand_idempotencyKey_key" ON "ManagedDeviceCommand"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ManagedDeviceCommand_managedDeviceId_createdAt_idx" ON "ManagedDeviceCommand"("managedDeviceId", "createdAt");

-- CreateIndex
CREATE INDEX "ManagedDeviceCommand_status_nextAttemptAt_createdAt_idx" ON "ManagedDeviceCommand"("status", "nextAttemptAt", "createdAt");

-- AddForeignKey
ALTER TABLE "ManagedDevice" ADD CONSTRAINT "ManagedDevice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "HirePurchaseContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedDevice" ADD CONSTRAINT "ManagedDevice_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedDevice" ADD CONSTRAINT "ManagedDevice_customerId_uuid_fkey" FOREIGN KEY ("customerId_uuid") REFERENCES "Customer"("id_uuid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedDeviceCommand" ADD CONSTRAINT "ManagedDeviceCommand_managedDeviceId_fkey" FOREIGN KEY ("managedDeviceId") REFERENCES "ManagedDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


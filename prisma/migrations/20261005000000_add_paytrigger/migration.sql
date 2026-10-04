-- PayTrigger: lock and unlock financed Transsion handsets (TECNO / Infinix /
-- itel), which Knox Guard cannot manage.
--
-- New tables only. No existing table is altered and no foreign key points at
-- one, so this migration cannot change how Knox, payments or contracts behave.
-- Idempotent, like the migrations before it, so a re-run is harmless.

CREATE TABLE IF NOT EXISTS "PayTriggerProduct" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayTriggerProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayTriggerDevice" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "contractId" TEXT,
    "imei" TEXT NOT NULL,
    "deviceTag" TEXT,
    "orderRef" TEXT,
    "enrollmentStatus" TEXT NOT NULL DEFAULT 'QUEUED',
    "committedState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "scheduleExpiresAt" TIMESTAMP(3),
    "providerExpiresAt" TIMESTAMP(3),
    "fingerprint" TEXT,
    "releaseAfter" TIMESTAMP(3),
    "releaseHeld" BOOLEAN NOT NULL DEFAULT false,
    "holdMessageShown" BOOLEAN NOT NULL DEFAULT false,
    "lastConnectAt" TIMESTAMP(3),
    "apkVersion" TEXT,
    "enforcementConfirmedAt" TIMESTAMP(3),
    "licenceConsumedAt" TIMESTAMP(3),
    "lastStatusReadAt" TIMESTAMP(3),
    "pinUnlocksUsed" INTEGER NOT NULL DEFAULT 0,
    "awaitingPinSince" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayTriggerDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayTriggerCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayTriggerCommand_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayTriggerActionLog" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT,
    "contractId" TEXT,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "providerCode" TEXT,
    "skippedReason" TEXT,
    "request" JSONB,
    "response" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayTriggerActionLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayTriggerWebhookEvent" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "notifyType" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayTriggerWebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PayTriggerSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultRuleNum" INTEGER NOT NULL DEFAULT 0,
    "lockAfterOverdueDays" INTEGER NOT NULL DEFAULT 1,
    "lockOnUnpaidAgentDeposit" BOOLEAN NOT NULL DEFAULT true,
    "holdOnUnpaidPenalties" BOOLEAN NOT NULL DEFAULT false,
    "maxUnlockHorizonDays" INTEGER NOT NULL DEFAULT 45,
    "releaseHoldHours" INTEGER NOT NULL DEFAULT 24,
    "extendBreakerPercent" INTEGER NOT NULL DEFAULT 20,
    "morningSweepCron" TEXT NOT NULL DEFAULT '36 8 * * *',
    "lockTitle" TEXT,
    "lockTips" TEXT,
    "depositHoldTitle" TEXT NOT NULL DEFAULT 'Phone not yet activated',
    "depositHoldTips" TEXT NOT NULL DEFAULT 'Your phone will be activated once your agent completes registration. Contact {agentName} on {agentPhone}.',
    "payDeeplink" TEXT,
    "ladder" JSONB,
    "operatorOfflineTimerHours" INTEGER NOT NULL DEFAULT 4392,
    "lastSweepAt" TIMESTAMP(3),
    "lastSweepSummary" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayTriggerSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerProduct_productId_key" ON "PayTriggerProduct"("productId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerDevice_inventoryItemId_key" ON "PayTriggerDevice"("inventoryItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerDevice_contractId_key" ON "PayTriggerDevice"("contractId");

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerDevice_imei_key" ON "PayTriggerDevice"("imei");

CREATE INDEX IF NOT EXISTS "PayTriggerDevice_enrollmentStatus_idx" ON "PayTriggerDevice"("enrollmentStatus");

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerCommand_idempotencyKey_key" ON "PayTriggerCommand"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "PayTriggerCommand_deviceId_createdAt_idx" ON "PayTriggerCommand"("deviceId", "createdAt");

CREATE INDEX IF NOT EXISTS "PayTriggerCommand_status_nextAttemptAt_idx" ON "PayTriggerCommand"("status", "nextAttemptAt");

CREATE INDEX IF NOT EXISTS "PayTriggerActionLog_deviceId_createdAt_idx" ON "PayTriggerActionLog"("deviceId", "createdAt");

CREATE INDEX IF NOT EXISTS "PayTriggerActionLog_contractId_createdAt_idx" ON "PayTriggerActionLog"("contractId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "PayTriggerWebhookEvent_dedupeKey_key" ON "PayTriggerWebhookEvent"("dedupeKey");


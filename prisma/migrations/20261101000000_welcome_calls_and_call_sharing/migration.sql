-- Welcome calls as a per-user permission, transfer history, and the daily
-- sharing of recovery / reminder calls. New tables only.
CREATE TABLE IF NOT EXISTS "AdminUserPermission" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminUserPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminUserPermission_adminUserId_permission_key" ON "AdminUserPermission"("adminUserId", "permission");
CREATE INDEX IF NOT EXISTS "AdminUserPermission_adminUserId_idx" ON "AdminUserPermission"("adminUserId");

CREATE TABLE IF NOT EXISTS "WelcomeCallTransfer" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fromOfficerId" TEXT,
    "toOfficerId" TEXT NOT NULL,
    "transferredById" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WelcomeCallTransfer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WelcomeCallTransfer_agentId_createdAt_idx" ON "WelcomeCallTransfer"("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "WelcomeCallTransfer_toOfficerId_createdAt_idx" ON "WelcomeCallTransfer"("toOfficerId", "createdAt");
CREATE INDEX IF NOT EXISTS "WelcomeCallTransfer_fromOfficerId_createdAt_idx" ON "WelcomeCallTransfer"("fromOfficerId", "createdAt");

CREATE TABLE IF NOT EXISTS "CallAllocation" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "customerId_uuid" UUID NOT NULL,
    "officerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "CallAllocation_day_customerId_uuid_key" ON "CallAllocation"("day", "customerId_uuid");
CREATE INDEX IF NOT EXISTS "CallAllocation_officerId_day_idx" ON "CallAllocation"("officerId", "day");

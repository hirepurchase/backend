-- Split agent commission: part kept at sale, the rest paid at completion.
--
-- Two columns added to CommissionSettings, both defaulting to 0, so the
-- existing single-payment commission is unchanged until management sets them.
-- One new table with no foreign keys. Idempotent.

ALTER TABLE "CommissionSettings" ADD COLUMN IF NOT EXISTS "deferredAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "CommissionSettings" ADD COLUMN IF NOT EXISTS "completionBonus" DOUBLE PRECISION NOT NULL DEFAULT 0;


CREATE TABLE IF NOT EXISTS "AgentCompletionCommission" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "upfrontAmount" DOUBLE PRECISION NOT NULL,
    "deferredAmount" DOUBLE PRECISION NOT NULL,
    "bonusAmount" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACCRUED',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompletionCommission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgentCompletionCommission_contractId_key" ON "AgentCompletionCommission"("contractId");

CREATE INDEX IF NOT EXISTS "AgentCompletionCommission_agentId_status_idx" ON "AgentCompletionCommission"("agentId", "status");

CREATE INDEX IF NOT EXISTS "AgentCompletionCommission_status_idx" ON "AgentCompletionCommission"("status");


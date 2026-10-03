-- Cluster leader scorecard: monthly performance pay for cluster leaders.
--
-- New tables only. No existing table is altered and no foreign key points at
-- one. Idempotent, so a re-run is harmless.

CREATE TABLE IF NOT EXISTS "ClusterAssignmentHistory" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "clusterAgentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterAssignmentHistory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClusterScorecardIndicator" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutType" TEXT NOT NULL DEFAULT 'RATE',
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "target" DOUBLE PRECISION,
    "targetDirection" TEXT NOT NULL DEFAULT 'GTE',
    "targetAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tiers" JSONB,
    "cap" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterScorecardIndicator_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClusterScorecardSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "baseAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "parGateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "parGateCeiling" DOUBLE PRECISION NOT NULL DEFAULT 25,
    "gateWithholdsBase" BOOLEAN NOT NULL DEFAULT false,
    "depositRemitDays" INTEGER NOT NULL DEFAULT 7,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterScorecardSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClusterScorecardPeriod" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "rulesSnapshot" JSONB NOT NULL,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterScorecardPeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClusterScorecardLine" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "clusterAgentId" TEXT NOT NULL,
    "indicatorKey" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "payout" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "detail" JSONB,

    CONSTRAINT "ClusterScorecardLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClusterPayout" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "clusterAgentId" TEXT NOT NULL,
    "base" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "variable" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deductions" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "gated" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterPayout_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ClusterAssignmentHistory_agentId_startedAt_idx" ON "ClusterAssignmentHistory"("agentId", "startedAt");

CREATE INDEX IF NOT EXISTS "ClusterAssignmentHistory_clusterAgentId_startedAt_idx" ON "ClusterAssignmentHistory"("clusterAgentId", "startedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "ClusterScorecardIndicator_key_key" ON "ClusterScorecardIndicator"("key");

CREATE UNIQUE INDEX IF NOT EXISTS "ClusterScorecardPeriod_month_key" ON "ClusterScorecardPeriod"("month");

CREATE INDEX IF NOT EXISTS "ClusterScorecardLine_periodId_idx" ON "ClusterScorecardLine"("periodId");

CREATE UNIQUE INDEX IF NOT EXISTS "ClusterScorecardLine_periodId_clusterAgentId_indicatorKey_key" ON "ClusterScorecardLine"("periodId", "clusterAgentId", "indicatorKey");

CREATE INDEX IF NOT EXISTS "ClusterPayout_clusterAgentId_idx" ON "ClusterPayout"("clusterAgentId");

CREATE UNIQUE INDEX IF NOT EXISTS "ClusterPayout_periodId_clusterAgentId_key" ON "ClusterPayout"("periodId", "clusterAgentId");


-- Start the history from today's assignments. Nothing records who led an
-- agent before now, so everything up to this point is credited to the current
-- leader — the same view the cluster dashboard already takes. From here on,
-- every move is tracked.
INSERT INTO "ClusterAssignmentHistory" ("id", "agentId", "clusterAgentId", "startedAt")
SELECT gen_random_uuid()::text, a."agentId", a."clusterAgentId", TIMESTAMP '2000-01-01 00:00:00'
FROM "ClusterAgentAssignment" a
WHERE NOT EXISTS (
  SELECT 1 FROM "ClusterAssignmentHistory" h
  WHERE h."agentId" = a."agentId" AND h."endedAt" IS NULL
);

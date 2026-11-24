-- CreateTable
CREATE TABLE "AgentCompletionPaySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "amountPerCompletion" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "threshold" INTEGER NOT NULL DEFAULT 10,
    "startMonth" TEXT NOT NULL DEFAULT '2026-11',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompletionPaySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCompletionPayPeriod" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "settingsSnapshot" JSONB NOT NULL,
    "closedById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompletionPayPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCompletionPayout" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "completedToDate" INTEGER NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "count" INTEGER NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "contracts" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCompletionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCompletionPayPeriod_month_key" ON "AgentCompletionPayPeriod"("month");

-- CreateIndex
CREATE INDEX "AgentCompletionPayout_agentId_idx" ON "AgentCompletionPayout"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCompletionPayout_periodId_agentId_key" ON "AgentCompletionPayout"("periodId", "agentId");


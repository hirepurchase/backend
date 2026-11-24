-- Rescheduling an expired contract's balance. Additive only.
ALTER TABLE "HirePurchaseContract" ADD COLUMN "originalEndDate" TIMESTAMP(3);
ALTER TABLE "HirePurchaseContract" ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ContractReschedule" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "balance" DOUBLE PRECISION NOT NULL,
    "lateCharges" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "principal" DOUBLE PRECISION NOT NULL,
    "monthlyRate" DOUBLE PRECISION NOT NULL,
    "termMonths" DOUBLE PRECISION NOT NULL,
    "interest" DOUBLE PRECISION NOT NULL,
    "newTotal" DOUBLE PRECISION NOT NULL,
    "frequency" TEXT NOT NULL,
    "installments" INTEGER NOT NULL,
    "installmentAmount" DOUBLE PRECISION NOT NULL,
    "firstDueDate" TIMESTAMP(3) NOT NULL,
    "newEndDate" TIMESTAMP(3),
    "oldEndDate" TIMESTAMP(3) NOT NULL,
    "oldSchedule" TEXT,
    "note" TEXT,
    "requestedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContractReschedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContractReschedule_status_createdAt_idx" ON "ContractReschedule"("status", "createdAt");
CREATE INDEX "ContractReschedule_contractId_status_idx" ON "ContractReschedule"("contractId", "status");
ALTER TABLE "ContractReschedule" ADD CONSTRAINT "ContractReschedule_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "HirePurchaseContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RescheduleSettings" (
    "id" TEXT NOT NULL,
    "autoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoAfterDays" INTEGER NOT NULL DEFAULT 7,
    "defaultMonthlyRate" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxMonthlyRate" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "autoFrequency" TEXT NOT NULL DEFAULT 'WEEKLY',
    "autoInstallments" INTEGER NOT NULL DEFAULT 8,
    "maxReschedulesPerContract" INTEGER NOT NULL DEFAULT 2,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RescheduleSettings_pkey" PRIMARY KEY ("id")
);

-- Expiry penalties: charge a contract that runs past its term still owing.
-- Written idempotently so a partially-applied run can be repeated safely.

-- Penalty: partial payment, classification, and a dedupe key so a repeated
-- accrual run cannot charge the same day twice.
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'LATE_INSTALLMENT';
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "periodDate" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Penalty_dedupeKey_key" ON "Penalty"("dedupeKey");
CREATE INDEX IF NOT EXISTS "Penalty_contractId_kind_idx" ON "Penalty"("contractId", "kind");

-- Penalties are not part of the purchase price. outstandingBalance is
-- recomputed as totalPrice - totalPaid on every payment, so anything added to
-- it is erased by the next one; they need a column of their own.
ALTER TABLE "HirePurchaseContract"
  ADD COLUMN IF NOT EXISTS "penaltyOutstanding" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "PenaltySettings" (
    "id" TEXT NOT NULL,
    "expiryPenaltyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expiryPenaltyMode" TEXT NOT NULL DEFAULT 'FIXED',
    "expiryPenaltyRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expiryGraceDays" INTEGER NOT NULL DEFAULT 0,
    "maxPenaltyPercentage" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "activatedAt" TIMESTAMP(3),
    "blockUnlockOnPenalty" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PenaltySettings_pkey" PRIMARY KEY ("id")
);

-- Backfill penaltyOutstanding from the penalties that already exist, so the
-- new column is correct from its first read rather than after the first write.
UPDATE "HirePurchaseContract" c
SET "penaltyOutstanding" = COALESCE(sub.total, 0)
FROM (
    SELECT "contractId", SUM("amount" - "paidAmount") AS total
    FROM "Penalty"
    WHERE "isPaid" = false
    GROUP BY "contractId"
) sub
WHERE c."id" = sub."contractId";


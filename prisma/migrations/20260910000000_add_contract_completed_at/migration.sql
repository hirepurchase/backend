-- Completion date for agent monthly bonus reporting.
ALTER TABLE "HirePurchaseContract" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Backfill from the final successful payment, which is what actually cleared
-- the balance. updatedAt is not usable here — any later edit moves it.
UPDATE "HirePurchaseContract" c
SET "completedAt" = p."lastPaid"
FROM (
  SELECT "contractId", MAX(COALESCE("paymentDate", "createdAt")) AS "lastPaid"
  FROM "PaymentTransaction"
  WHERE "status" = 'SUCCESS'
  GROUP BY "contractId"
) p
WHERE c."id" = p."contractId"
  AND c."status" = 'COMPLETED'
  AND c."completedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "HirePurchaseContract_status_completedAt_idx"
  ON "HirePurchaseContract"("status", "completedAt");

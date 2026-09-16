-- Supervised exception to the arrears lock: an admin-approved window during
-- which an overdue customer's phone stays open so they can clear what they owe.
ALTER TABLE "KnoxGuardSettings"
  ADD COLUMN IF NOT EXISTS "temporaryUnlockMaxWeeks" INTEGER NOT NULL DEFAULT 4;

CREATE TABLE IF NOT EXISTS "TemporaryUnlockRequest" (
  "id"                TEXT NOT NULL,
  "contractId"        TEXT NOT NULL,
  "agentId"           TEXT NOT NULL,
  "requestedById"     TEXT NOT NULL,
  "requestedWeeks"    INTEGER NOT NULL,
  "reason"            TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "approvedWeeks"     INTEGER,
  "expiresAt"         TIMESTAMP(3),
  "arrearsAtApproval" DOUBLE PRECISION,
  "reviewedById"      TEXT,
  "reviewedAt"        TIMESTAMP(3),
  "reviewNote"        TEXT,
  "resolvedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TemporaryUnlockRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TemporaryUnlockRequest_status_expiresAt_idx"
  ON "TemporaryUnlockRequest"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "TemporaryUnlockRequest_contractId_status_idx"
  ON "TemporaryUnlockRequest"("contractId", "status");
CREATE INDEX IF NOT EXISTS "TemporaryUnlockRequest_agentId_status_idx"
  ON "TemporaryUnlockRequest"("agentId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'TemporaryUnlockRequest_contractId_fkey') THEN
    ALTER TABLE "TemporaryUnlockRequest" ADD CONSTRAINT "TemporaryUnlockRequest_contractId_fkey"
      FOREIGN KEY ("contractId") REFERENCES "HirePurchaseContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'TemporaryUnlockRequest_agentId_fkey') THEN
    ALTER TABLE "TemporaryUnlockRequest" ADD CONSTRAINT "TemporaryUnlockRequest_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'TemporaryUnlockRequest_requestedById_fkey') THEN
    ALTER TABLE "TemporaryUnlockRequest" ADD CONSTRAINT "TemporaryUnlockRequest_requestedById_fkey"
      FOREIGN KEY ("requestedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'TemporaryUnlockRequest_reviewedById_fkey') THEN
    ALTER TABLE "TemporaryUnlockRequest" ADD CONSTRAINT "TemporaryUnlockRequest_reviewedById_fkey"
      FOREIGN KEY ("reviewedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

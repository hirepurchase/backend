-- Customer service officer portal: agent assignments and call logging

CREATE TABLE IF NOT EXISTS "CsoAgentAssignment" (
  "id" TEXT NOT NULL,
  "csoId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "assignedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CsoAgentAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CsoAgentAssignment_csoId_agentId_key" ON "CsoAgentAssignment"("csoId", "agentId");
CREATE INDEX IF NOT EXISTS "CsoAgentAssignment_csoId_idx" ON "CsoAgentAssignment"("csoId");
CREATE INDEX IF NOT EXISTS "CsoAgentAssignment_agentId_idx" ON "CsoAgentAssignment"("agentId");

CREATE TABLE IF NOT EXISTS "ContactAttempt" (
  "id" TEXT NOT NULL,
  "customerId_uuid" UUID NOT NULL,
  "contractId" TEXT,
  "installmentId" TEXT,
  "officerId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "verificationResult" TEXT,
  "notes" TEXT,
  "promiseToPayDate" TIMESTAMP(3),
  "promiseToPayAmount" DOUBLE PRECISION,
  "nextFollowUpAt" TIMESTAMP(3),
  "contactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContactAttempt_customerId_uuid_contactedAt_idx" ON "ContactAttempt"("customerId_uuid", "contactedAt");
CREATE INDEX IF NOT EXISTS "ContactAttempt_contractId_purpose_idx" ON "ContactAttempt"("contractId", "purpose");
CREATE INDEX IF NOT EXISTS "ContactAttempt_officerId_contactedAt_idx" ON "ContactAttempt"("officerId", "contactedAt");
CREATE INDEX IF NOT EXISTS "ContactAttempt_nextFollowUpAt_idx" ON "ContactAttempt"("nextFollowUpAt");
CREATE INDEX IF NOT EXISTS "ContactAttempt_purpose_verificationResult_idx" ON "ContactAttempt"("purpose", "verificationResult");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'CsoAgentAssignment_csoId_fkey') THEN
    ALTER TABLE "CsoAgentAssignment" ADD CONSTRAINT "CsoAgentAssignment_csoId_fkey"
      FOREIGN KEY ("csoId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'CsoAgentAssignment_agentId_fkey') THEN
    ALTER TABLE "CsoAgentAssignment" ADD CONSTRAINT "CsoAgentAssignment_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'CsoAgentAssignment_assignedById_fkey') THEN
    ALTER TABLE "CsoAgentAssignment" ADD CONSTRAINT "CsoAgentAssignment_assignedById_fkey"
      FOREIGN KEY ("assignedById") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ContactAttempt_customerId_uuid_fkey') THEN
    ALTER TABLE "ContactAttempt" ADD CONSTRAINT "ContactAttempt_customerId_uuid_fkey"
      FOREIGN KEY ("customerId_uuid") REFERENCES "Customer"("id_uuid") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ContactAttempt_contractId_fkey') THEN
    ALTER TABLE "ContactAttempt" ADD CONSTRAINT "ContactAttempt_contractId_fkey"
      FOREIGN KEY ("contractId") REFERENCES "HirePurchaseContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'ContactAttempt_officerId_fkey') THEN
    ALTER TABLE "ContactAttempt" ADD CONSTRAINT "ContactAttempt_officerId_fkey"
      FOREIGN KEY ("officerId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Paid temporary unlock and agent deposits on the short code. Additive only.

-- Paid temporary unlock settings (off until switched on).
ALTER TABLE "KnoxGuardSettings"
  ADD COLUMN "temporaryUnlockEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temporaryUnlockMaxUses" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "temporaryUnlockTiers" JSONB NOT NULL DEFAULT '[{"percent":25,"hours":24,"feePercent":0},{"percent":50,"hours":72,"feePercent":0},{"percent":75,"hours":120,"feePercent":0},{"percent":90,"hours":168,"feePercent":0}]';

-- A paid unlock's charge rides on its payment; it is not money towards the contract.
ALTER TABLE "PaymentTransaction" ADD COLUMN "unlockFee" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "PaidTemporaryUnlock" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "hours" INTEGER NOT NULL,
    "overdueAmount" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clientReference" TEXT NOT NULL,
    "paymentId" TEXT,
    "requestedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaidTemporaryUnlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaidTemporaryUnlock_clientReference_key" ON "PaidTemporaryUnlock"("clientReference");
CREATE INDEX "PaidTemporaryUnlock_contractId_status_idx" ON "PaidTemporaryUnlock"("contractId", "status");
CREATE INDEX "PaidTemporaryUnlock_status_expiresAt_idx" ON "PaidTemporaryUnlock"("status", "expiresAt");

-- Agent payment PIN.
ALTER TABLE "AdminUser" ADD COLUMN "paymentPin" TEXT;
CREATE UNIQUE INDEX "AdminUser_paymentPin_key" ON "AdminUser"("paymentPin");

CREATE TABLE "AgentPinFailure" (
    "id" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentPinFailure_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentPinFailure_msisdn_createdAt_idx" ON "AgentPinFailure"("msisdn", "createdAt");

-- Short-code deposit charges.
ALTER TABLE "AgentDepositPayment"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'WEB',
  ADD COLUMN "clientReference" TEXT;
CREATE INDEX "AgentDepositPayment_clientReference_idx" ON "AgentDepositPayment"("clientReference");
UPDATE "AgentDepositPayment" SET "channel" = 'MANUAL' WHERE "network" = 'MANUAL';

-- Give every selling agent a PIN: six digits, no leading zero, unique.
DO $$
DECLARE agent RECORD; pin TEXT;
BEGIN
  FOR agent IN
    SELECT u."id" FROM "AdminUser" u JOIN "Role" r ON r."id" = u."roleId"
    WHERE r."name" IN ('AGENT', 'CLUSTER_AGENT') AND u."paymentPin" IS NULL
  LOOP
    LOOP
      pin := (100000 + floor(random() * 900000))::int::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "AdminUser" WHERE "paymentPin" = pin);
    END LOOP;
    UPDATE "AdminUser" SET "paymentPin" = pin WHERE "id" = agent."id";
  END LOOP;
END $$;

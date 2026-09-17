-- A penalty can now be waived rather than only paid.
--
-- Completion is blocked while any penalty stands, so before this a single
-- wrongly-raised charge trapped a contract permanently: the device never
-- released, ownership never transferred, and the only remedy was editing the
-- database by hand. Waiving keeps the row — a charge that was wrong is still
-- something that happened, and who cancelled it matters.
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "isWaived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "waivedAt" TIMESTAMP(3);
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "waivedById" TEXT;
ALTER TABLE "Penalty" ADD COLUMN IF NOT EXISTS "waiveReason" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Penalty_waivedById_fkey'
  ) THEN
    ALTER TABLE "Penalty"
      ADD CONSTRAINT "Penalty_waivedById_fkey"
      FOREIGN KEY ("waivedById") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Reporting on daily accrual scans by kind and period.
CREATE INDEX IF NOT EXISTS "Penalty_kind_periodDate_idx" ON "Penalty"("kind", "periodDate");

ALTER TABLE "PenaltySettings" ADD COLUMN IF NOT EXISTS "notifyCustomer" BOOLEAN NOT NULL DEFAULT true;

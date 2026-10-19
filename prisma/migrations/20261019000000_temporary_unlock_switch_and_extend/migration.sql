-- Temporary unlocks:
--   * an admin switch for the rule that stops an agent from creating new
--     contracts while a customer whose unlock ran out unpaid still owes
--     (defaults to on, which is how the system behaves today);
--   * a count and date of extensions, for windows an admin reopens after
--     they ran out unpaid.
-- Additive with defaults, so nothing changes on its own. Idempotent.

ALTER TABLE "KnoxGuardSettings" ADD COLUMN IF NOT EXISTS "temporaryUnlockDefaultBlocksSales" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "TemporaryUnlockRequest" ADD COLUMN IF NOT EXISTS "extensionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TemporaryUnlockRequest" ADD COLUMN IF NOT EXISTS "lastExtendedAt" TIMESTAMP(3);

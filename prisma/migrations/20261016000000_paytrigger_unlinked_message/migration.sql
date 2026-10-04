-- PayTrigger: the lock-screen text for a phone that has activated but is not
-- on an active contract. Two columns with defaults on PayTrigger's own
-- settings row; nothing else changes. Idempotent.

ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "unlinkedTitle" TEXT NOT NULL DEFAULT 'Phone not yet activated for use';
ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "unlinkedTips" TEXT NOT NULL DEFAULT 'This phone is locked because it is not yet linked to an active hire purchase contract. Please contact AIDOO TECH customer service on 0303981216.';

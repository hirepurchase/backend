-- Remembers the text last pushed to a device's lock screen.
--
-- A successful direct dispatch writes no ManagedDeviceCommand row (those are
-- created only when a command has to be retried), so there was no durable
-- record of what the customer is currently reading. Refreshing a stale lock
-- message needs that record: without it every evaluation would see "no prior
-- message", decide the text had changed, and re-lock the phone every five
-- minutes.
ALTER TABLE "ManagedDevice" ADD COLUMN IF NOT EXISTS "lastLockMessage" TEXT;

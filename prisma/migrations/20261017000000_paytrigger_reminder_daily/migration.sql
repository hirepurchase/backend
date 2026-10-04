-- PayTrigger reminders: daily-collection customers are left out unless an
-- admin turns this on, so they are not sent a pop-up every morning.
-- One column with a default on PayTrigger's own settings row. Idempotent.

ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderIncludeDaily" BOOLEAN NOT NULL DEFAULT false;

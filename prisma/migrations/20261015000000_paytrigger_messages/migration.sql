-- PayTrigger: personalised lock-screen text and reminders of upcoming payments.
--
-- Columns are added to PayTrigger's own tables only, each with a default, so
-- nothing changes until an admin turns reminders on or writes a lock message.
-- Idempotent, like the migrations before it.

ALTER TABLE "PayTriggerDevice" ADD COLUMN IF NOT EXISTS "lockMessageKey" TEXT;

ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderDaysBefore" TEXT NOT NULL DEFAULT '3,1,0';
ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderChannel" TEXT NOT NULL DEFAULT 'POPUP';
ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderTitle" TEXT NOT NULL DEFAULT 'Payment reminder';
ALTER TABLE "PayTriggerSettings" ADD COLUMN IF NOT EXISTS "reminderText" TEXT NOT NULL DEFAULT 'Dear {firstName}, your payment of {amount} is due on {dueDate}. Please pay on time to keep your phone open.';

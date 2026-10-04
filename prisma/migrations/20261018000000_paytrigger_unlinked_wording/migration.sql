-- PayTrigger: plainer wording for a phone that is locked because it has no
-- contract. Changes the column defaults, and the settings row only where it
-- still holds the earlier default (an admin's own wording is left alone).

ALTER TABLE "PayTriggerSettings" ALTER COLUMN "unlinkedTitle" SET DEFAULT 'No contract on this device';
ALTER TABLE "PayTriggerSettings" ALTER COLUMN "unlinkedTips" SET DEFAULT 'Your device does not have a contract. Please contact AIDOO TECH on 0303981216.';

UPDATE "PayTriggerSettings"
   SET "unlinkedTitle" = 'No contract on this device'
 WHERE "unlinkedTitle" = 'Phone not yet activated for use';

UPDATE "PayTriggerSettings"
   SET "unlinkedTips" = 'Your device does not have a contract. Please contact AIDOO TECH on 0303981216.'
 WHERE "unlinkedTips" = 'This phone is locked because it is not yet linked to an active hire purchase contract. Please contact AIDOO TECH customer service on 0303981216.';

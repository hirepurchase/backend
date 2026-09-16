-- "Hold the device while penalties are unpaid" already exists as
-- KnoxGuardSettings.blockOnUnpaidPenalties, which is the flag the lock decision
-- actually reads. A second column answering the same question could only ever
-- disagree with it, so it is removed and the penalties settings page writes
-- through to the Knox one instead.
ALTER TABLE "PenaltySettings" DROP COLUMN IF EXISTS "blockUnlockOnPenalty";

-- One live request per contract, enforced by the database rather than by a
-- read-then-write check in the controller. Two concurrent submissions (a
-- double-click, a client retry) could both pass that check and be approved
-- into overlapping unlock windows.
--
-- Partial index: only PENDING and APPROVED rows are constrained, so a contract
-- can be granted a second window once the first is rejected, withdrawn,
-- fulfilled or defaulted.
CREATE UNIQUE INDEX IF NOT EXISTS "TemporaryUnlockRequest_one_live_per_contract"
  ON "TemporaryUnlockRequest"("contractId")
  WHERE "status" IN ('PENDING', 'APPROVED');

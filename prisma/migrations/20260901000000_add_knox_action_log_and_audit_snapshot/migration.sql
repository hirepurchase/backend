-- Durable per-attempt Knox action history and daily full-fleet audit snapshots
CREATE TABLE IF NOT EXISTS "KnoxActionLog" (
  "id"                TEXT NOT NULL,
  "managedDeviceId"   TEXT,
  "contractId"        TEXT,
  "contractNumber"    TEXT,
  "actionType"        TEXT NOT NULL,
  "source"            TEXT NOT NULL,
  "success"           BOOLEAN NOT NULL,
  "dryRun"            BOOLEAN NOT NULL,
  "desiredState"      TEXT,
  "actualStateBefore" TEXT,
  "actualStateAfter"  TEXT,
  "error"             TEXT,
  "transactionId"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "KnoxActionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "KnoxActionLog_managedDeviceId_createdAt_idx"
  ON "KnoxActionLog"("managedDeviceId", "createdAt");

CREATE INDEX IF NOT EXISTS "KnoxActionLog_actionType_success_createdAt_idx"
  ON "KnoxActionLog"("actionType", "success", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'KnoxActionLog_managedDeviceId_fkey'
    AND table_name = 'KnoxActionLog'
  ) THEN
    ALTER TABLE "KnoxActionLog"
      ADD CONSTRAINT "KnoxActionLog_managedDeviceId_fkey"
      FOREIGN KEY ("managedDeviceId") REFERENCES "ManagedDevice"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DeviceAuditSnapshot" (
  "id"             TEXT NOT NULL,
  "categoryACount" INTEGER NOT NULL,
  "categoryBCount" INTEGER NOT NULL,
  "categoryCCount" INTEGER NOT NULL,
  "totalIssues"    INTEGER NOT NULL,
  "totalDevices"   INTEGER NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeviceAuditSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeviceAuditSnapshot_createdAt_idx"
  ON "DeviceAuditSnapshot"("createdAt");

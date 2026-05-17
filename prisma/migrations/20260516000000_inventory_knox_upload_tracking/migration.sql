ALTER TABLE "InventoryItem"
  ADD COLUMN "knoxUploadStatus"  TEXT,
  ADD COLUMN "knoxUploadId"      TEXT,
  ADD COLUMN "knoxUploadError"   TEXT,
  ADD COLUMN "knoxUploadRetries" INTEGER NOT NULL DEFAULT 0;

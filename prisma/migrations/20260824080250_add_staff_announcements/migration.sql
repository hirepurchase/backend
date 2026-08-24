-- Staff announcements: admin-posted notices shown to targeted roles on login
CREATE TABLE IF NOT EXISTS "StaffAnnouncement" (
  "id"            TEXT NOT NULL,
  "message"       TEXT NOT NULL,
  "targetRoleIds" TEXT[] NOT NULL,
  "createdById"   TEXT NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StaffAnnouncement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StaffAnnouncement_isActive_expiresAt_idx"
  ON "StaffAnnouncement"("isActive", "expiresAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'StaffAnnouncement_createdById_fkey'
    AND table_name = 'StaffAnnouncement'
  ) THEN
    ALTER TABLE "StaffAnnouncement"
      ADD CONSTRAINT "StaffAnnouncement_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

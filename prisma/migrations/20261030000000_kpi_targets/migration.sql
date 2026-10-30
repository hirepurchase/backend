-- KPI targets. New table only; nothing existing is altered.
CREATE TABLE IF NOT EXISTS "KpiTarget" (
    "id" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KpiTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "KpiTarget_group_key_key" ON "KpiTarget"("group", "key");

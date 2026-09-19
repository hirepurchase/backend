-- Block agents from new contracts while their PAR30 is above a limit.
-- Off by default; threshold and minimum book size are configurable.
ALTER TABLE "SupervisionSettings" ADD COLUMN IF NOT EXISTS "parBlockEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SupervisionSettings" ADD COLUMN IF NOT EXISTS "parBlockThreshold" DOUBLE PRECISION NOT NULL DEFAULT 20;
ALTER TABLE "SupervisionSettings" ADD COLUMN IF NOT EXISTS "parBlockMinContracts" INTEGER NOT NULL DEFAULT 10;

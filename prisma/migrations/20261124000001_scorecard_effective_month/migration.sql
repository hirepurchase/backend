-- Leader pay starts with November 2026; earlier months are shown but not paid.
ALTER TABLE "ClusterScorecardSettings" ADD COLUMN "effectiveMonth" TEXT NOT NULL DEFAULT '2026-11';

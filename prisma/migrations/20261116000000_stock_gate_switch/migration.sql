-- An on/off switch for refusing new devices to agents below target.
-- Off by default: the sales and quality targets can be set without blocking stock.
ALTER TABLE "ClusterScorecardSettings" ADD COLUMN "stockGateEnabled" BOOLEAN NOT NULL DEFAULT false;

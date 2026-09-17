-- Whether an agent must be supervised before they can create contracts.
--
-- Both flags default to false. At the time of writing there were 96 active
-- agents, none of them assigned to a cluster agent, and no cluster agents at
-- all — so enabling this on deploy would have blocked every sale in the
-- company simultaneously. The hierarchy gets built first; the rule is switched
-- on afterwards.
CREATE TABLE IF NOT EXISTS "SupervisionSettings" (
    "id" TEXT NOT NULL,
    "requireClusterAgent" BOOLEAN NOT NULL DEFAULT false,
    "requireCso" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupervisionSettings_pkey" PRIMARY KEY ("id")
);

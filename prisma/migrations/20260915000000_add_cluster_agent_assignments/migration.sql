-- Cluster agents: a management line over agents. One cluster agent per agent,
-- so agentId is unique rather than a composite with the supervisor.
CREATE TABLE IF NOT EXISTS "ClusterAgentAssignment" (
  "id"             TEXT NOT NULL,
  "clusterAgentId" TEXT NOT NULL,
  "agentId"        TEXT NOT NULL,
  "assignedById"   TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClusterAgentAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ClusterAgentAssignment_agentId_key"
  ON "ClusterAgentAssignment"("agentId");

CREATE INDEX IF NOT EXISTS "ClusterAgentAssignment_clusterAgentId_idx"
  ON "ClusterAgentAssignment"("clusterAgentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ClusterAgentAssignment_clusterAgentId_fkey'
    AND table_name = 'ClusterAgentAssignment'
  ) THEN
    ALTER TABLE "ClusterAgentAssignment"
      ADD CONSTRAINT "ClusterAgentAssignment_clusterAgentId_fkey"
      FOREIGN KEY ("clusterAgentId") REFERENCES "AdminUser"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ClusterAgentAssignment_agentId_fkey'
    AND table_name = 'ClusterAgentAssignment'
  ) THEN
    ALTER TABLE "ClusterAgentAssignment"
      ADD CONSTRAINT "ClusterAgentAssignment_agentId_fkey"
      FOREIGN KEY ("agentId") REFERENCES "AdminUser"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ClusterAgentAssignment_assignedById_fkey'
    AND table_name = 'ClusterAgentAssignment'
  ) THEN
    ALTER TABLE "ClusterAgentAssignment"
      ADD CONSTRAINT "ClusterAgentAssignment_assignedById_fkey"
      FOREIGN KEY ("assignedById") REFERENCES "AdminUser"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

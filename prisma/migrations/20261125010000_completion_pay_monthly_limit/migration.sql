-- AlterTable
ALTER TABLE "AgentCompletionPaySettings" ADD COLUMN     "maxPerMonth" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "AgentCompletionPayout" ADD COLUMN     "carriedOver" INTEGER NOT NULL DEFAULT 0;


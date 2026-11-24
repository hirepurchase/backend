-- Payout MoMo number for commission, set by each user from their own portal.
ALTER TABLE "AdminUser" ADD COLUMN "payoutMomoNumber" TEXT,
ADD COLUMN "payoutMomoNetwork" TEXT,
ADD COLUMN "payoutMomoName" TEXT,
ADD COLUMN "payoutMomoCheck" TEXT,
ADD COLUMN "payoutMomoUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "payoutPaystackRecipient" TEXT,
ADD COLUMN     "payoutPaystackRecipientKey" TEXT;

-- AlterTable
ALTER TABLE "PaymentGatewaySettings" ADD COLUMN     "payoutGateway" TEXT NOT NULL DEFAULT 'PAYSTACK';

-- CreateTable
CREATE TABLE "CommissionTransfer" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "gateway" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "registeredName" TEXT,
    "nameCheck" TEXT,
    "confirmedMismatch" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT NOT NULL,
    "externalRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "initiatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CommissionTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTransfer_reference_key" ON "CommissionTransfer"("reference");

-- CreateIndex
CREATE INDEX "CommissionTransfer_kind_payoutId_idx" ON "CommissionTransfer"("kind", "payoutId");

-- CreateIndex
CREATE INDEX "CommissionTransfer_status_updatedAt_idx" ON "CommissionTransfer"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "CommissionTransfer_recipientId_idx" ON "CommissionTransfer"("recipientId");


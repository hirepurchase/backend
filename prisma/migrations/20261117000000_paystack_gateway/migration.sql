-- Paystack as a second gateway for web and app payments. Additive only:
-- existing rows are Hubtel, and both switches start on Hubtel.
ALTER TABLE "PaymentTransaction" ADD COLUMN "gateway" TEXT NOT NULL DEFAULT 'HUBTEL';
ALTER TABLE "AgentDepositPayment" ADD COLUMN "gateway" TEXT NOT NULL DEFAULT 'HUBTEL';

-- The gateway's fee on a payment, when it reports one (Paystack), for
-- matching settlements to the bank. Contracts are credited the full amount.
ALTER TABLE "PaymentTransaction" ADD COLUMN "gatewayFee" DOUBLE PRECISION;
ALTER TABLE "AgentDepositPayment" ADD COLUMN "gatewayFee" DOUBLE PRECISION;

CREATE TABLE "PaymentGatewaySettings" (
    "id" TEXT NOT NULL,
    "customerGateway" TEXT NOT NULL DEFAULT 'HUBTEL',
    "agentDepositGateway" TEXT NOT NULL DEFAULT 'HUBTEL',
    "lastPaystackEventAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentGatewaySettings_pkey" PRIMARY KEY ("id")
);

-- Waiting Paystack charges are checked by the sweep.
CREATE INDEX "PaymentTransaction_gateway_status_idx" ON "PaymentTransaction"("gateway", "status");

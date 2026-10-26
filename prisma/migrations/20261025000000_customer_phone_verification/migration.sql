-- Registered-name check for customer and guarantor phone numbers. Additive only.
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "phoneVerificationStatus" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "phoneRegisteredName" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "phoneNameScore" INTEGER;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorVerificationStatus" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorRegisteredName" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorNameScore" INTEGER;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorVerifiedAt" TIMESTAMP(3);

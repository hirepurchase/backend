-- Add guarantor fields to Customer table
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorName" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "guarantorPhone" TEXT;

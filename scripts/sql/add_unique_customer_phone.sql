-- Add unique constraint on Customer.phone
-- Run this only after normalizing phones and resolving duplicates.

create unique index if not exists "Customer_phone_key"
  on "Customer" ("phone");

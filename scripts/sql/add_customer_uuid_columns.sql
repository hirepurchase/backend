-- Phase 1: Add UUID columns and backfill
create extension if not exists "pgcrypto";

alter table "Customer" add column if not exists "id_uuid" uuid default gen_random_uuid();

alter table "HirePurchaseContract" add column if not exists "customerId_uuid" uuid;
alter table "PaymentTransaction" add column if not exists "customerId_uuid" uuid;
alter table "NotificationLog" add column if not exists "customerId_uuid" uuid;
alter table "HubtelPreapproval" add column if not exists "customerId_uuid" uuid;
alter table "PasswordResetOtp" add column if not exists "customerId_uuid" uuid;

update "HirePurchaseContract" h
set "customerId_uuid" = c."id_uuid"
from "Customer" c
where h."customerId" = c."id";

update "PaymentTransaction" p
set "customerId_uuid" = c."id_uuid"
from "Customer" c
where p."customerId" = c."id";

update "NotificationLog" n
set "customerId_uuid" = c."id_uuid"
from "Customer" c
where n."customerId" = c."id";

update "HubtelPreapproval" hp
set "customerId_uuid" = c."id_uuid"
from "Customer" c
where hp."customerId" = c."id";

update "PasswordResetOtp" pr
set "customerId_uuid" = c."id_uuid"
from "Customer" c
where pr."customerId" = c."id";

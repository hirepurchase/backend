-- Phase 3: Add FK constraints on UUID columns (after dual-write and backfill)
alter table "HirePurchaseContract"
  add constraint if not exists "HirePurchaseContract_customerId_uuid_fkey"
  foreign key ("customerId_uuid") references "Customer"("id_uuid") on delete cascade;

alter table "PaymentTransaction"
  add constraint if not exists "PaymentTransaction_customerId_uuid_fkey"
  foreign key ("customerId_uuid") references "Customer"("id_uuid") on delete cascade;

alter table "NotificationLog"
  add constraint if not exists "NotificationLog_customerId_uuid_fkey"
  foreign key ("customerId_uuid") references "Customer"("id_uuid") on delete cascade;

alter table "HubtelPreapproval"
  add constraint if not exists "HubtelPreapproval_customerId_uuid_fkey"
  foreign key ("customerId_uuid") references "Customer"("id_uuid") on delete cascade;

alter table "PasswordResetOtp"
  add constraint if not exists "PasswordResetOtp_customerId_uuid_fkey"
  foreign key ("customerId_uuid") references "Customer"("id_uuid") on delete cascade;

-- Set UUID columns to NOT NULL after backfill and dual-write
alter table "Customer"
  alter column "id_uuid" set not null;

alter table "HirePurchaseContract"
  alter column "customerId_uuid" set not null;

alter table "PaymentTransaction"
  alter column "customerId_uuid" set not null;

alter table "NotificationLog"
  alter column "customerId_uuid" set not null;

alter table "HubtelPreapproval"
  alter column "customerId_uuid" set not null;

alter table "PasswordResetOtp"
  alter column "customerId_uuid" set not null;

-- Phase 6: Drop old text customerId columns (after verification)
alter table "HirePurchaseContract" drop column if exists "customerId";
alter table "PaymentTransaction" drop column if exists "customerId";
alter table "NotificationLog" drop column if exists "customerId";
alter table "HubtelPreapproval" drop column if exists "customerId";
alter table "PasswordResetOtp" drop column if exists "customerId";

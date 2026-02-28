-- Phase 5: Drop old text-based foreign key constraints
alter table "HirePurchaseContract" drop constraint if exists "HirePurchaseContract_customerId_fkey";
alter table "PaymentTransaction" drop constraint if exists "PaymentTransaction_customerId_fkey";
alter table "NotificationLog" drop constraint if exists "NotificationLog_customerId_fkey";
alter table "HubtelPreapproval" drop constraint if exists "HubtelPreapproval_customerId_fkey";
alter table "PasswordResetOtp" drop constraint if exists "PasswordResetOtp_customerId_fkey";

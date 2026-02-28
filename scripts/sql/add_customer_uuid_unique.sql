-- Ensure id_uuid is populated and unique before adding FK constraints
create extension if not exists "pgcrypto";

update "Customer"
set "id_uuid" = gen_random_uuid()
where "id_uuid" is null;

alter table "Customer"
  add constraint "Customer_id_uuid_key" unique ("id_uuid");

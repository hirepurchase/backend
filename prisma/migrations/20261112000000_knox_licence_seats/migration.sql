-- How many Knox Guard licence seats have been bought, entered by a super admin. Additive only.
ALTER TABLE "KnoxGuardSettings" ADD COLUMN "licenceSeatsPurchased" INTEGER;

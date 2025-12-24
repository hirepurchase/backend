# Database Migration: Add Preapproval to Contract

This migration adds the ability to link contracts to Hubtel preapproval records for direct debit tracking.

## What This Migration Does

1. Adds `hubtelPreapprovalId` column to the `HirePurchaseContract` table
2. Creates a foreign key relationship to the `HubtelPreapproval` table
3. Creates an index for improved query performance
4. Allows admins to see which contracts have approved direct debit mandates

## Option 1: Run Using psql (Recommended)

### From your Supabase connection string:
```bash
# Your database URL from .env file
psql "postgresql://postgres.mjeytynpoecqeypaiojt:Year22025@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
  -f add_preapproval_to_contract.sql
```

### Or if you're on the database server:
```bash
cd /home/wilsonjunior/Documents/hirepurchase/backend
psql -U postgres -d your_database_name -f add_preapproval_to_contract.sql
```

## Option 2: Run Using Supabase Dashboard

1. Go to https://supabase.com/dashboard
2. Select your project
3. Navigate to **SQL Editor**
4. Click **New Query**
5. Copy the contents of `add_preapproval_to_contract.sql`
6. Paste and click **Run**

## Option 3: Run Using pgAdmin or DBeaver

1. Open your database tool
2. Connect to your PostgreSQL database
3. Open a new SQL query window
4. Copy and paste the contents of `add_preapproval_to_contract.sql`
5. Execute the query

## Verification

After running the migration, verify it worked:

```sql
-- Check if column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'HirePurchaseContract'
AND column_name = 'hubtelPreapprovalId';

-- Should show:
-- column_name           | data_type | is_nullable
-- hubtelPreapprovalId   | text      | YES
```

## Rollback (If Needed)

If you need to undo this migration:

```bash
psql "your_connection_string" -f rollback_preapproval_to_contract.sql
```

## After Migration

Once the migration is complete, restart your backend server:

```bash
cd /home/wilsonjunior/Documents/hirepurchase/backend
npm run dev
```

## Files Included

- `add_preapproval_to_contract.sql` - The migration script
- `rollback_preapproval_to_contract.sql` - Rollback script (use only if needed)
- `MIGRATION_INSTRUCTIONS.md` - This file

## Troubleshooting

### Error: "relation does not exist"
Make sure the `HirePurchaseContract` and `HubtelPreapproval` tables exist in your database.

### Error: "permission denied"
You need database admin privileges to run ALTER TABLE commands.

### Error: "column already exists"
The migration has already been run. You can safely skip it or check if it was successful using the verification query above.

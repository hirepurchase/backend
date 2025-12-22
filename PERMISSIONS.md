# Permissions System

This document describes the permissions system implemented in the Hire Purchase application.

## New Permissions Added

### Inventory Permissions
- **EDIT_INVENTORY**: Edit inventory item details (lock status, registered under)
  - Required for: Updating inventory item lock status and registered under fields
  - Route: `PUT /api/products/inventory/:id`
  - Used by: Inventory management page

### Hubtel Payment Permissions
- **MANAGE_HUBTEL_PAYMENTS**: Manage Hubtel payment settings and retry configurations
  - Required for: Viewing and updating retry settings
  - Routes:
    - `GET /api/payment-retry/settings`
    - `PUT /api/payment-retry/settings`
  - Used by: Payment Retry Settings page

- **VIEW_FAILED_PAYMENTS**: View failed payment transactions
  - Required for: Viewing list of failed payments and retry history
  - Routes:
    - `GET /api/payment-retry/failed`
    - `GET /api/payment-retry/history/:paymentId`
  - Used by: Failed Payments page

- **RETRY_PAYMENTS**: Retry failed payment transactions
  - Required for: Triggering payment retries
  - Routes:
    - `POST /api/payment-retry/retry/:paymentId`
    - `POST /api/payment-retry/retry-multiple`
    - `POST /api/payment-retry/retry-all`
  - Used by: Failed Payments page (retry actions)

## All Permissions

1. **CREATE_CUSTOMER**: Create new customers
2. **VIEW_CUSTOMERS**: View customer list and details
3. **UPDATE_CUSTOMER**: Edit customer information
4. **DELETE_CUSTOMER**: Delete customers
5. **MANAGE_PRODUCTS**: Create and manage products
6. **MANAGE_INVENTORY**: Manage inventory items (add, bulk import)
7. **EDIT_INVENTORY**: Edit inventory item details (NEW)
8. **CREATE_CONTRACT**: Create hire purchase contracts
9. **VIEW_CONTRACTS**: View contracts
10. **UPDATE_CONTRACT**: Update/amend contract terms
11. **CANCEL_CONTRACT**: Cancel contracts
12. **DELETE_CONTRACT**: Delete contracts
13. **RECORD_PAYMENT**: Record manual payments
14. **VIEW_PAYMENTS**: View payment transactions
15. **MANAGE_HUBTEL_PAYMENTS**: Manage Hubtel payment settings (NEW)
16. **VIEW_FAILED_PAYMENTS**: View failed payment transactions (NEW)
17. **RETRY_PAYMENTS**: Retry failed payment transactions (NEW)
18. **VIEW_REPORTS**: View reports
19. **EXPORT_REPORTS**: Export reports to files
20. **MANAGE_SETTINGS**: Manage system settings and notifications
21. **MANAGE_USERS**: Manage admin users
22. **MANAGE_ROLES**: Create and manage roles
23. **MANAGE_PERMISSIONS**: Assign permissions to roles
24. **VIEW_AUDIT_LOGS**: View system audit trail

## Role Permissions

### SUPER_ADMIN
- Has ALL permissions
- Cannot be deleted (system role)
- Can manage users, roles, and Hubtel payment settings

### ADMIN
- Has all permissions EXCEPT:
  - MANAGE_USERS
  - MANAGE_ROLES
  - MANAGE_PERMISSIONS
  - MANAGE_HUBTEL_PAYMENTS
- Can perform day-to-day operations but cannot modify system configuration

### SALES_AGENT
- Limited permissions for sales operations:
  - CREATE_CUSTOMER
  - VIEW_CUSTOMERS
  - UPDATE_CUSTOMER
  - CREATE_CONTRACT
  - VIEW_CONTRACTS
  - RECORD_PAYMENT
  - VIEW_PAYMENTS
  - VIEW_FAILED_PAYMENTS

## Using Permissions in Frontend

### Hook: `usePermissions()`

```typescript
import { usePermissions } from '@/hooks/usePermissions';

function MyComponent() {
  const { hasPermission, hasAnyPermission, hasAllPermissions } = usePermissions();

  // Check single permission
  if (hasPermission('EDIT_INVENTORY')) {
    // Show edit button
  }

  // Check if user has any of the permissions
  if (hasAnyPermission(['EDIT_INVENTORY', 'MANAGE_INVENTORY'])) {
    // Show inventory management section
  }

  // Check if user has all permissions
  if (hasAllPermissions(['CREATE_CONTRACT', 'RECORD_PAYMENT'])) {
    // Show advanced contract creation
  }
}
```

### Example: Conditional Rendering

```typescript
const { hasPermission } = usePermissions();

return (
  <div>
    {hasPermission('EDIT_INVENTORY') && (
      <Button onClick={handleEdit}>Edit Inventory</Button>
    )}

    {hasPermission('MANAGE_HUBTEL_PAYMENTS') && (
      <Link href="/admin/settings/retry-settings">Payment Settings</Link>
    )}
  </div>
);
```

### Example: Disabling Buttons

```typescript
const { hasPermission } = usePermissions();
const canEdit = hasPermission('EDIT_INVENTORY');

return (
  <Button
    disabled={!canEdit}
    onClick={handleEdit}
  >
    Edit
  </Button>
);
```

## Backend Route Protection

All protected routes use the `requirePermission` middleware:

```typescript
router.put('/inventory/:id', requirePermission('EDIT_INVENTORY'), updateInventoryItem);
router.get('/settings', requirePermission('MANAGE_HUBTEL_PAYMENTS'), getSettings);
```

## Adding New Permissions

1. **Add to seed file** (`backend/prisma/seed.ts`):
   ```typescript
   const permissions = [
     // ... existing permissions
     { name: 'NEW_PERMISSION', description: 'Description of the permission' },
   ];
   ```

2. **Update role assignments** (in seed file):
   ```typescript
   const adminRole = await prisma.role.upsert({
     // ... config
     permissions: {
       connect: allPermissions
         .filter(p => !['EXCLUDED_PERMS'].includes(p.name))
         .map(p => ({ id: p.id })),
     },
   });
   ```

3. **Protect routes** in backend:
   ```typescript
   router.post('/new-route', requirePermission('NEW_PERMISSION'), handler);
   ```

4. **Use in frontend**:
   ```typescript
   const { hasPermission } = usePermissions();
   if (hasPermission('NEW_PERMISSION')) {
     // Show UI element
   }
   ```

5. **Run seed** to update database:
   ```bash
   cd backend
   npx ts-node prisma/seed.ts
   ```

## Security Notes

- Permissions are checked on **both frontend and backend**
- Frontend checks provide better UX (hide unauthorized UI)
- Backend checks provide actual security (prevent unauthorized API calls)
- Never rely on frontend-only permission checks for security
- All sensitive operations must be protected by backend middleware
- Super Admin role is system-protected and cannot be deleted

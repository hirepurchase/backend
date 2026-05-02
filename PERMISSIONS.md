# Permissions System

This project uses a role-permission model for admin users. The canonical permission list now lives in [src/constants/permissions.ts](/home/wilsonjunior/Documents/hirepurchase/backend/src/constants/permissions.ts:1), and both backend enforcement and frontend UI checks should reference that shared vocabulary.

## Key Rules

- `SUPER_ADMIN` bypasses permission checks.
- Route middleware uses `requireAnyPermission(...)`, which means multiple permissions are treated as **OR**, not AND.
- Scoped permissions such as `VIEW_OWN_CUSTOMERS` and `VIEW_OWN_CONTRACTS` are enforced in controllers, not only at the route layer.
- Frontend checks are only for UX. Backend checks are the security boundary.

## Permission Model

### Customers
- `CREATE_CUSTOMER`: create customer records
- `VIEW_CUSTOMERS`: view all customers
- `VIEW_OWN_CUSTOMERS`: view only customers created by the signed-in admin
- `UPDATE_CUSTOMER`: edit customer information
- `DELETE_CUSTOMER`: delete customers

### Inventory
- `MANAGE_PRODUCTS`: create and manage products
- `EDIT_PRODUCT`: edit product details
- `MANAGE_INVENTORY`: add and manage inventory items
- `EDIT_INVENTORY`: edit inventory item details
- `DELETE_INVENTORY`: delete inventory items

### Contracts
- `CREATE_CONTRACT`: create contracts
- `VIEW_CONTRACTS`: view all contracts
- `VIEW_OWN_CONTRACTS`: view only contracts created by the signed-in admin
- `UPDATE_CONTRACT`: amend contracts, installments, transfers, and servicing data
- `CANCEL_CONTRACT`: cancel contracts
- `DELETE_CONTRACT`: permanently delete contracts
- `MANAGE_CONTRACTS`: direct debit and preapproval operations
- `APPROVE_CONTRACT`: approve or request revision for pending contracts
- `VIEW_CONTRACT_APPROVALS`: view the approval queue

### Payments
- `RECORD_PAYMENT`: record manual payments
- `VIEW_PAYMENTS`: view payment transactions
- `MANAGE_HUBTEL_PAYMENTS`: manage retry/payment gateway operational settings
- `VIEW_FAILED_PAYMENTS`: view failed payment transactions
- `RETRY_PAYMENTS`: retry failed payments
- `VIEW_DAILY_PAYMENTS`: view daily payment summaries

### Reporting
- `VIEW_DASHBOARD`: access dashboard summaries
- `VIEW_REPORTS`: access reports
- `EXPORT_REPORTS`: export report data

### Administration
- `MANAGE_SETTINGS`: notifications, imports, operational SMS, and utility settings
- `MANAGE_USERS`: manage admin users
- `MANAGE_ROLES`: manage roles
- `MANAGE_PERMISSIONS`: assign permissions to roles
- `VIEW_AUDIT_LOGS`: view audit trails

## Shared Access Groups

These grouped rules are defined in code to keep routes and UI consistent:

- `CUSTOMER_ACCESS_PERMISSIONS`
  - `VIEW_CUSTOMERS`
  - `VIEW_OWN_CUSTOMERS`
- `CONTRACT_ACCESS_PERMISSIONS`
  - `VIEW_CONTRACTS`
  - `VIEW_OWN_CONTRACTS`
- `CONTRACT_APPROVAL_ACCESS_PERMISSIONS`
  - `VIEW_CONTRACT_APPROVALS`
  - `APPROVE_CONTRACT`
- `DASHBOARD_ACCESS_PERMISSIONS`
  - `VIEW_DASHBOARD`
  - `VIEW_REPORTS`
  - `VIEW_CONTRACTS`
  - `VIEW_OWN_CONTRACTS`

## Seeded Roles

### `SUPER_ADMIN`
- All permissions.

### `ADMIN`
- Operational access, excluding:
  - `MANAGE_USERS`
  - `MANAGE_ROLES`
  - `MANAGE_PERMISSIONS`
  - `MANAGE_HUBTEL_PAYMENTS`
  - `DELETE_INVENTORY`

### `SALES_AGENT`
- Customer creation and own-customer visibility
- Contract creation and own-contract visibility
- Payment recording/viewing
- Failed-payment viewing
- Dashboard access

### `AGENT`
- Customer creation and own-customer visibility
- Inventory management/editing
- Contract creation and own-contract visibility
- Payment recording/viewing
- Dashboard access

## Implementation Guidance

### Backend

Prefer importing constants and groups:

```ts
import { PERMISSIONS, CONTRACT_ACCESS_PERMISSIONS } from '../constants/permissions';
import { requireAnyPermission } from '../middleware/auth';

router.get('/', authenticateAdmin, requireAnyPermission(...CONTRACT_ACCESS_PERMISSIONS), getAllContracts);
router.delete('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.DELETE_CONTRACT), deleteContract);
```

For scoped resources, route guards are not enough. The controller must also check ownership when a user has only the `VIEW_OWN_*` permission.

### Frontend

Use [frontend/src/lib/permissions.ts](/home/wilsonjunior/Documents/hirepurchase/frontend/src/lib/permissions.ts:1) instead of raw strings:

```ts
import { PERMISSIONS, CONTRACT_ACCESS_PERMISSIONS } from '@/lib/permissions';
import { usePermissions } from '@/hooks/usePermissions';

const { hasPermission, hasAnyPermission } = usePermissions();

const canEditInventory = hasPermission(PERMISSIONS.EDIT_INVENTORY);
const canViewContracts = hasAnyPermission(CONTRACT_ACCESS_PERMISSIONS);
```

## Common Pitfalls

- Do not assume `requireAnyPermission(A, B)` means both `A` and `B` are required.
- Do not seed agent roles with broad `VIEW_CUSTOMERS` / `VIEW_CONTRACTS` if the intended behavior is “only my records.”
- Do not expose UI based on one permission while the backend route uses a different permission name.
- Do not add a new permission in routes or frontend without adding it to the seed definitions.

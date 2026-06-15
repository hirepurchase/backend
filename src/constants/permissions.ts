export const PERMISSIONS = {
  CREATE_CUSTOMER: 'CREATE_CUSTOMER',
  VIEW_CUSTOMERS: 'VIEW_CUSTOMERS',
  VIEW_OWN_CUSTOMERS: 'VIEW_OWN_CUSTOMERS',
  UPDATE_CUSTOMER: 'UPDATE_CUSTOMER',
  DELETE_CUSTOMER: 'DELETE_CUSTOMER',
  MANAGE_PRODUCTS: 'MANAGE_PRODUCTS',
  EDIT_PRODUCT: 'EDIT_PRODUCT',
  MANAGE_INVENTORY: 'MANAGE_INVENTORY',
  EDIT_INVENTORY: 'EDIT_INVENTORY',
  DELETE_INVENTORY: 'DELETE_INVENTORY',
  CREATE_CONTRACT: 'CREATE_CONTRACT',
  VIEW_CONTRACTS: 'VIEW_CONTRACTS',
  VIEW_OWN_CONTRACTS: 'VIEW_OWN_CONTRACTS',
  UPDATE_CONTRACT: 'UPDATE_CONTRACT',
  CANCEL_CONTRACT: 'CANCEL_CONTRACT',
  WRITE_OFF_CONTRACT: 'WRITE_OFF_CONTRACT',
  DELETE_CONTRACT: 'DELETE_CONTRACT',
  MANAGE_CONTRACTS: 'MANAGE_CONTRACTS',
  RECORD_PAYMENT: 'RECORD_PAYMENT',
  VIEW_PAYMENTS: 'VIEW_PAYMENTS',
  MANAGE_HUBTEL_PAYMENTS: 'MANAGE_HUBTEL_PAYMENTS',
  VIEW_FAILED_PAYMENTS: 'VIEW_FAILED_PAYMENTS',
  RETRY_PAYMENTS: 'RETRY_PAYMENTS',
  VIEW_DAILY_PAYMENTS: 'VIEW_DAILY_PAYMENTS',
  VIEW_DEVICE_CONTROL: 'VIEW_DEVICE_CONTROL',
  MANAGE_DEVICE_CONTROL: 'MANAGE_DEVICE_CONTROL',
  VIEW_DASHBOARD: 'VIEW_DASHBOARD',
  VIEW_REPORTS: 'VIEW_REPORTS',
  EXPORT_REPORTS: 'EXPORT_REPORTS',
  MANAGE_SETTINGS: 'MANAGE_SETTINGS',
  MANAGE_USERS: 'MANAGE_USERS',
  MANAGE_ROLES: 'MANAGE_ROLES',
  MANAGE_PERMISSIONS: 'MANAGE_PERMISSIONS',
  VIEW_AUDIT_LOGS: 'VIEW_AUDIT_LOGS',
  APPROVE_CONTRACT: 'APPROVE_CONTRACT',
  VIEW_CONTRACT_APPROVALS: 'VIEW_CONTRACT_APPROVALS',
  VIEW_AGENT_COMMISSIONS: 'VIEW_AGENT_COMMISSIONS',
  MANAGE_COMMISSION_SETTINGS: 'MANAGE_COMMISSION_SETTINGS',
  MANAGE_AGENT_LEDGER: 'MANAGE_AGENT_LEDGER',
  PAY_AGENT_DEPOSIT: 'PAY_AGENT_DEPOSIT',
} as const;

export type PermissionName = typeof PERMISSIONS[keyof typeof PERMISSIONS];

type PermissionCategory =
  | 'Customers'
  | 'Inventory'
  | 'Contracts'
  | 'Payments'
  | 'Reporting'
  | 'Administration';

type PermissionScope = 'all' | 'own' | 'action';

export interface PermissionDefinition {
  name: PermissionName;
  description: string;
  category: PermissionCategory;
  scope: PermissionScope;
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { name: PERMISSIONS.CREATE_CUSTOMER, description: 'Create new customers', category: 'Customers', scope: 'action' },
  { name: PERMISSIONS.VIEW_CUSTOMERS, description: 'View all customer records', category: 'Customers', scope: 'all' },
  { name: PERMISSIONS.VIEW_OWN_CUSTOMERS, description: 'View only customers created by the signed-in admin', category: 'Customers', scope: 'own' },
  { name: PERMISSIONS.UPDATE_CUSTOMER, description: 'Edit customer information', category: 'Customers', scope: 'action' },
  { name: PERMISSIONS.DELETE_CUSTOMER, description: 'Delete customers', category: 'Customers', scope: 'action' },
  { name: PERMISSIONS.MANAGE_PRODUCTS, description: 'Create and manage products', category: 'Inventory', scope: 'action' },
  { name: PERMISSIONS.EDIT_PRODUCT, description: 'Edit product details (name, description, price, category)', category: 'Inventory', scope: 'action' },
  { name: PERMISSIONS.MANAGE_INVENTORY, description: 'Manage inventory items', category: 'Inventory', scope: 'action' },
  { name: PERMISSIONS.EDIT_INVENTORY, description: 'Edit inventory item details (lock status, registered under)', category: 'Inventory', scope: 'action' },
  { name: PERMISSIONS.DELETE_INVENTORY, description: 'Delete inventory items', category: 'Inventory', scope: 'action' },
  { name: PERMISSIONS.CREATE_CONTRACT, description: 'Create hire purchase contracts', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.VIEW_CONTRACTS, description: 'View all contracts', category: 'Contracts', scope: 'all' },
  { name: PERMISSIONS.VIEW_OWN_CONTRACTS, description: 'View only contracts created by the signed-in admin', category: 'Contracts', scope: 'own' },
  { name: PERMISSIONS.UPDATE_CONTRACT, description: 'Update or amend contract terms', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.CANCEL_CONTRACT, description: 'Cancel contracts', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.WRITE_OFF_CONTRACT, description: 'Write off unrecoverable contracts', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.DELETE_CONTRACT, description: 'Delete contracts', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.MANAGE_CONTRACTS, description: 'Manage contract servicing operations such as direct debit and preapprovals', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.RECORD_PAYMENT, description: 'Record manual payments', category: 'Payments', scope: 'action' },
  { name: PERMISSIONS.VIEW_PAYMENTS, description: 'View payment transactions', category: 'Payments', scope: 'all' },
  { name: PERMISSIONS.MANAGE_HUBTEL_PAYMENTS, description: 'Manage Hubtel payment settings and retry configurations', category: 'Payments', scope: 'action' },
  { name: PERMISSIONS.VIEW_FAILED_PAYMENTS, description: 'View failed payment transactions', category: 'Payments', scope: 'all' },
  { name: PERMISSIONS.RETRY_PAYMENTS, description: 'Retry failed payment transactions', category: 'Payments', scope: 'action' },
  { name: PERMISSIONS.VIEW_DAILY_PAYMENTS, description: 'View daily payments notifications and summary', category: 'Payments', scope: 'all' },
  { name: PERMISSIONS.VIEW_DEVICE_CONTROL, description: 'View financed device control status and command history', category: 'Contracts', scope: 'all' },
  { name: PERMISSIONS.MANAGE_DEVICE_CONTROL, description: 'Enroll, lock, unlock, and sync financed devices through Knox Guard', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.VIEW_DASHBOARD, description: 'View dashboard statistics and personal dashboard summaries', category: 'Reporting', scope: 'all' },
  { name: PERMISSIONS.VIEW_REPORTS, description: 'View reports', category: 'Reporting', scope: 'all' },
  { name: PERMISSIONS.EXPORT_REPORTS, description: 'Export reports to files', category: 'Reporting', scope: 'action' },
  { name: PERMISSIONS.MANAGE_SETTINGS, description: 'Manage system settings, notifications, imports, and operational messaging', category: 'Administration', scope: 'action' },
  { name: PERMISSIONS.MANAGE_USERS, description: 'Manage admin users', category: 'Administration', scope: 'action' },
  { name: PERMISSIONS.MANAGE_ROLES, description: 'Create and manage roles', category: 'Administration', scope: 'action' },
  { name: PERMISSIONS.MANAGE_PERMISSIONS, description: 'Assign permissions to roles', category: 'Administration', scope: 'action' },
  { name: PERMISSIONS.VIEW_AUDIT_LOGS, description: 'View system audit trail', category: 'Administration', scope: 'all' },
  { name: PERMISSIONS.APPROVE_CONTRACT, description: 'Approve or request revision for contracts pending approval', category: 'Contracts', scope: 'action' },
  { name: PERMISSIONS.VIEW_CONTRACT_APPROVALS, description: 'View contracts pending approval', category: 'Contracts', scope: 'all' },
  { name: PERMISSIONS.VIEW_AGENT_COMMISSIONS, description: 'View own commission and deposit ledger', category: 'Payments', scope: 'own' },
  { name: PERMISSIONS.MANAGE_COMMISSION_SETTINGS, description: 'Configure agent commission settings', category: 'Administration', scope: 'action' },
  { name: PERMISSIONS.MANAGE_AGENT_LEDGER, description: 'View all agents deposit and commission ledgers', category: 'Payments', scope: 'all' },
  { name: PERMISSIONS.PAY_AGENT_DEPOSIT, description: 'Remit agent deposit collection to company via mobile money', category: 'Payments', scope: 'action' },
];

export const CUSTOMER_ACCESS_PERMISSIONS = [
  PERMISSIONS.VIEW_CUSTOMERS,
  PERMISSIONS.VIEW_OWN_CUSTOMERS,
] as const;

export const CONTRACT_ACCESS_PERMISSIONS = [
  PERMISSIONS.VIEW_CONTRACTS,
  PERMISSIONS.VIEW_OWN_CONTRACTS,
] as const;

export const CONTRACT_APPROVAL_ACCESS_PERMISSIONS = [
  PERMISSIONS.VIEW_CONTRACT_APPROVALS,
  PERMISSIONS.APPROVE_CONTRACT,
] as const;

export const DASHBOARD_ACCESS_PERMISSIONS = [
  PERMISSIONS.VIEW_DASHBOARD,
  PERMISSIONS.VIEW_REPORTS,
  PERMISSIONS.VIEW_CONTRACTS,
  PERMISSIONS.VIEW_OWN_CONTRACTS,
] as const;

export const DAILY_PAYMENTS_ACCESS_PERMISSIONS = [
  PERMISSIONS.VIEW_DAILY_PAYMENTS,
  PERMISSIONS.VIEW_PAYMENTS,
  PERMISSIONS.VIEW_REPORTS,
] as const;

export const ROLE_DIRECTORY_ACCESS_PERMISSIONS = [
  PERMISSIONS.MANAGE_ROLES,
  PERMISSIONS.MANAGE_USERS,
] as const;

export function hasPermission(userPermissions: readonly string[] | undefined, permission: PermissionName): boolean {
  return userPermissions?.includes(permission) ?? false;
}

export function hasAnyPermission(
  userPermissions: readonly string[] | undefined,
  permissions: readonly PermissionName[]
): boolean {
  return permissions.some((permission) => hasPermission(userPermissions, permission));
}

export function hasAllPermissions(
  userPermissions: readonly string[] | undefined,
  permissions: readonly PermissionName[]
): boolean {
  return permissions.every((permission) => hasPermission(userPermissions, permission));
}

export function toPermissionNames(userPermissions: readonly string[]): PermissionName[] {
  return userPermissions as PermissionName[];
}

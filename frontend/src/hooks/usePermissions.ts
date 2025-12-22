import { useAuthStore } from '@/store/authStore';
import { AdminUser } from '@/types';

export function usePermissions() {
  const { user, userType } = useAuthStore();

  const hasPermission = (permission: string): boolean => {
    if (userType !== 'admin' || !user) {
      return false;
    }

    const adminUser = user as AdminUser;
    return adminUser.permissions?.includes(permission) || false;
  };

  const hasAnyPermission = (permissions: string[]): boolean => {
    return permissions.some((permission) => hasPermission(permission));
  };

  const hasAllPermissions = (permissions: string[]): boolean => {
    return permissions.every((permission) => hasPermission(permission));
  };

  return {
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  };
}

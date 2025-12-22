'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAuth?: boolean;
  userType?: 'admin' | 'customer';
  permissions?: string[];
}

export default function ProtectedRoute({
  children,
  requireAuth = true,
  userType,
  permissions,
}: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, userType: currentUserType, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    if (requireAuth && !isAuthenticated) {
      // Not authenticated, redirect to appropriate login
      const loginPath = userType === 'admin' ? '/admin-login' : '/customer-login';
      router.push(loginPath);
      return;
    }

    if (userType && currentUserType !== userType) {
      // Wrong user type, redirect to appropriate login
      const loginPath = userType === 'admin' ? '/admin-login' : '/customer-login';
      router.push(loginPath);
      return;
    }

    if (permissions && currentUserType === 'admin') {
      const adminUser = user as any;
      const hasPermission = permissions.some(perm =>
        adminUser?.permissions?.includes(perm) || adminUser?.role === 'SUPER_ADMIN'
      );

      if (!hasPermission) {
        router.push('/admin/dashboard');
        return;
      }
    }
  }, [isLoading, isAuthenticated, currentUserType, userType, permissions, router, user]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isAuthenticated || (userType && currentUserType !== userType)) {
    return null;
  }

  return <>{children}</>;
}

import { create } from 'zustand';
import { AdminUser, Customer } from '@/types';

interface AuthState {
  user: AdminUser | Customer | null;
  userType: 'admin' | 'customer' | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setAuth: (user: AdminUser | Customer, userType: 'admin' | 'customer', token: string) => void;
  logout: () => void;
  initializeAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  userType: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,

  setAuth: (user, userType, token) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('token', token);
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('userType', userType);
    }

    set({
      user,
      userType,
      token,
      isAuthenticated: true,
      isLoading: false,
    });
  },

  logout: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('userType');
    }

    set({
      user: null,
      userType: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  initializeAuth: () => {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      set({ isLoading: false });
      return;
    }

    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    const userType = localStorage.getItem('userType') as 'admin' | 'customer' | null;

    if (token && userStr && userType) {
      try {
        const user = JSON.parse(userStr);
        set({
          user,
          userType,
          token,
          isAuthenticated: true,
          isLoading: false,
        });
      } catch {
        // Invalid stored data, clear it
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('userType');
        set({ isLoading: false });
      }
    } else {
      set({ isLoading: false });
    }
  },
}));

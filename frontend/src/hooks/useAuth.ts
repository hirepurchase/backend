import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/authStore";
import api from "@/lib/api";
import { LoginResponse } from "@/types";

export function useAuth() {
  const {
    user,
    userType,
    token,
    isAuthenticated,
    isLoading,
    setAuth,
    logout,
    initializeAuth,
  } = useAuthStore();
  const router = useRouter();

  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  const loginAdmin = async (email: string, password: string) => {
    try {
      const response = await api.post<LoginResponse>("/auth/admin-login", {
        email,
        password,
      });
      const { token, user } = response.data;
      setAuth(user, "admin", token);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error || "Login failed",
      };
    }
  };

  const loginCustomer = async (email: string, password: string) => {
    try {
      const response = await api.post<LoginResponse>("/auth/customer-login", {
        email,
        password,
      });
      const { token, user } = response.data;
      setAuth(user, "customer", token);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error || "Login failed",
      };
    }
  };

  const activateAccount = async (
    membershipId: string,
    email: string,
    password: string
  ) => {
    try {
      const response = await api.post<LoginResponse>(
        "/auth/customer/activate",
        {
          membershipId,
          email,
          password,
        }
      );
      const { token, user } = response.data;
      setAuth(user, "customer", token);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error || "Account activation failed",
      };
    }
  };

  const logoutUser = () => {
    logout();
    const loginPath = userType === "admin" ? "/admin-login" : "/customer-login";
    router.push(loginPath);
  };

  return {
    user,
    userType,
    token,
    isAuthenticated,
    isLoading,
    loginAdmin,
    loginCustomer,
    activateAccount,
    logout: logoutUser,
  };
}

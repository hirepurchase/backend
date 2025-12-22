"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Home,
  FileText,
  CreditCard,
  User,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function CustomerSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Type guard to check if user is a customer
  const customerUser = user && "membershipId" in user ? user : null;

  const navigation = [
    { name: "Dashboard", href: "/customer/dashboard", icon: Home },
    { name: "My Contracts", href: "/customer/contracts", icon: FileText },
    { name: "Payments", href: "/customer/payments", icon: CreditCard },
    { name: "Profile", href: "/customer/profile", icon: User },
  ];

  const handleLogout = () => {
    logout();
    setMobileMenuOpen(false);
    router.push("/customer/login");
  };

  const SidebarContent = () => (
    <>
      {/* Header */}
      <div className="p-4 sm:p-6 border-b border-green-700">
        <h1 className="text-lg sm:text-2xl font-bold">AIDOO TECH</h1>
        <p className="text-green-100 text-xs sm:text-sm mt-1 truncate">
          {user?.firstName} {user?.lastName}
        </p>
        <p className="text-green-200 text-xs font-mono mt-0.5 truncate">
          ID: {customerUser?.membershipId}
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-3 sm:p-4 space-y-2 overflow-y-auto">
        {navigation.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <button
              key={item.name}
              onClick={() => {
                router.push(item.href);
                setMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-3 px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg transition-colors text-sm sm:text-base",
                isActive
                  ? "bg-white text-green-800 font-medium"
                  : "text-green-100 hover:bg-green-700"
              )}
            >
              <Icon className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0" />
              <span className="truncate">{item.name}</span>
            </button>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="p-3 sm:p-4 border-t border-green-700">
        <Button
          variant="outline"
          className="w-full bg-transparent border-white text-white hover:bg-green-700 text-sm sm:text-base h-9 sm:h-10"
          onClick={handleLogout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Logout
        </Button>
      </div>

      {/* Footer */}
      <div className="p-3 sm:p-4 border-t border-green-700">
        <p className="text-xs text-green-200">
          EYO Solutions
          <br />
          0246-462398
        </p>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile Menu Button */}
      <button
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-green-600 text-white rounded-lg shadow-lg"
      >
        {mobileMenuOpen ? (
          <X className="h-6 w-6" />
        ) : (
          <Menu className="h-6 w-6" />
        )}
      </button>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black bg-opacity-50 z-40"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Desktop Sidebar */}
      <div className="hidden lg:flex h-screen w-64 flex-col bg-gradient-to-b from-green-600 to-green-800 text-white">
        <SidebarContent />
      </div>

      {/* Mobile Sidebar */}
      <div
        className={cn(
          "lg:hidden fixed inset-y-0 left-0 z-40 w-64 flex flex-col bg-gradient-to-b from-green-600 to-green-800 text-white transform transition-transform duration-300 ease-in-out",
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent />
      </div>
    </>
  );
}

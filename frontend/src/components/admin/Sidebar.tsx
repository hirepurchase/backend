"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Package,
  Warehouse,
  FileText,
  CreditCard,
  BarChart3,
  Shield,
  History,
  Settings,
  Bell,
  LogOut,
  Menu,
  X,
  Upload,
  AlertCircle,
  RefreshCw,
  TestTube2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { name: "Customers", href: "/admin/customers", icon: Users },
  { name: "Products", href: "/admin/products", icon: Package },
  { name: "Inventory", href: "/admin/inventory", icon: Warehouse },
  { name: "Contracts", href: "/admin/contracts", icon: FileText },
  { name: "Payments", href: "/admin/payments", icon: CreditCard },
  { name: "Payment Management", href: "/admin/failed-payments", icon: AlertCircle },
  { name: "Hubtel Test", href: "/admin/hubtel-test", icon: TestTube2 },
  { name: "Reports", href: "/admin/reports", icon: BarChart3 },
  { name: "Import Data", href: "/admin/import", icon: Upload },
  { name: "Notifications", href: "/admin/settings/notifications", icon: Bell },
  { name: "Users", href: "/admin/users", icon: Settings },
  { name: "Roles & Permissions", href: "/admin/roles", icon: Shield },
  { name: "Audit Trail", href: "/admin/audit", icon: History },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const SidebarContent = () => (
    <>
      {/* Logo */}
      <div className="flex h-14 sm:h-16 items-center justify-center border-b border-gray-800 px-4">
        <h1 className="text-lg sm:text-xl font-bold">AIDOO TECH</h1>
      </div>

      {/* User Info */}
      <div className="border-b border-gray-800 p-3 sm:p-4">
        <p className="text-xs sm:text-sm font-medium truncate">
          {(user as any)?.firstName} {(user as any)?.lastName}
        </p>
        <p className="text-xs text-gray-400 truncate">{(user as any)?.role}</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3 sm:p-4 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={() => setMobileMenuOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium transition-colors",
                isActive
                  ? "bg-gray-800 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              )}
            >
              <item.icon className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0" />
              <span className="truncate">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="border-t border-gray-800 p-3 sm:p-4">
        <button
          onClick={() => {
            logout();
            setMobileMenuOpen(false);
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs sm:text-sm font-medium text-gray-300 transition-colors hover:bg-gray-800 hover:text-white"
        >
          <LogOut className="h-4 w-4 sm:h-5 sm:w-5" />
          Logout
        </button>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-800 p-3 sm:p-4">
        <p className="text-xs text-gray-400">
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
        className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-gray-900 text-white rounded-lg shadow-lg"
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
      <div className="hidden lg:flex h-screen w-64 flex-col bg-gray-900 text-white">
        <SidebarContent />
      </div>

      {/* Mobile Sidebar */}
      <div
        className={cn(
          "lg:hidden fixed inset-y-0 left-0 z-40 w-64 flex flex-col bg-gray-900 text-white transform transition-transform duration-300 ease-in-out",
          mobileMenuOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <SidebarContent />
      </div>
    </>
  );
}

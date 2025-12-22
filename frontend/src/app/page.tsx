"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ShoppingCart,
  Users,
  FileText,
  CreditCard,
  ArrowRight,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100">
      {/* Navigation Bar */}
      <nav className="bg-white/80 backdrop-blur-md border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <ShoppingCart className="h-6 w-6 sm:h-8 sm:w-8 text-blue-600" />
              <span className="ml-2 text-lg sm:text-xl font-bold text-gray-900">
                AIDOO TECH
              </span>
            </div>

            {/* Desktop Menu */}
            <div className="hidden md:flex items-center gap-4">
              <Button
                variant="ghost"
                onClick={() => router.push("/customer-login")}
              >
                Customer Login
              </Button>
              <Button onClick={() => router.push("/admin-login")}>
                Admin Login
              </Button>
            </div>

            {/* Mobile Menu Button */}
            <button
              className="md:hidden p-2"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <X className="h-6 w-6 text-gray-700" />
              ) : (
                <Menu className="h-6 w-6 text-gray-700" />
              )}
            </button>
          </div>

          {/* Mobile Menu */}
          {mobileMenuOpen && (
            <div className="md:hidden py-4 space-y-2 border-t">
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => {
                  router.push("/customer-login");
                  setMobileMenuOpen(false);
                }}
              >
                Customer Login
              </Button>
              <Button
                className="w-full"
                onClick={() => {
                  router.push("/admin-login");
                  setMobileMenuOpen(false);
                }}
              >
                Admin Login
              </Button>
            </div>
          )}
        </div>
      </nav>

      {/* Hero Section */}
      <section className="py-12 sm:py-16 md:py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto text-center">
          <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-extrabold text-gray-900 mb-4 sm:mb-6 px-4">
            AIDOO TECH
            <span className="block text-blue-600 mt-2">
              Hire Purchase Solutions
            </span>
          </h1>
          <p className="text-base sm:text-lg md:text-xl text-gray-600 mb-6 sm:mb-8 md:mb-10 max-w-3xl mx-auto px-4">
            Modern hire purchase management system. Manage customers, contracts,
            and payments with ease.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center px-4">
            <Button
              size="lg"
              className="text-base sm:text-lg px-6 sm:px-8 py-5 sm:py-6 w-full sm:w-auto"
              onClick={() => router.push("/admin-login")}
            >
              Get Started
              <ArrowRight className="ml-2 h-4 w-4 sm:h-5 sm:w-5" />
            </Button>
          </div>
        </div>
      </section>

      {/* Features Section - Only show on tablet and up */}
      <section className="hidden sm:block py-12 md:py-20 px-4 sm:px-6 lg:px-8 bg-white/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8 md:mb-16">
            <h2 className="text-2xl md:text-4xl font-bold text-gray-900 mb-2 md:mb-4">
              Key Features
            </h2>
            <p className="text-lg md:text-xl text-gray-600">
              Everything you need to manage your hire purchase business
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-8">
            <Card className="border-2 hover:border-blue-500 transition-all hover:shadow-lg">
              <CardHeader>
                <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-3 md:mb-4">
                  <Users className="h-5 w-5 md:h-6 md:w-6 text-blue-600" />
                </div>
                <CardTitle className="text-lg md:text-xl">Customer Management</CardTitle>
                <CardDescription className="text-sm md:text-base">
                  Manage customer profiles and contracts
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 hover:border-green-500 transition-all hover:shadow-lg">
              <CardHeader>
                <div className="w-10 h-10 md:w-12 md:h-12 bg-green-100 rounded-lg flex items-center justify-center mb-3 md:mb-4">
                  <FileText className="h-5 w-5 md:h-6 md:w-6 text-green-600" />
                </div>
                <CardTitle className="text-lg md:text-xl">Contract Creation</CardTitle>
                <CardDescription className="text-sm md:text-base">
                  Create hire purchase contracts easily
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 hover:border-purple-500 transition-all hover:shadow-lg">
              <CardHeader>
                <div className="w-10 h-10 md:w-12 md:h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-3 md:mb-4">
                  <CreditCard className="h-5 w-5 md:h-6 md:w-6 text-purple-600" />
                </div>
                <CardTitle className="text-lg md:text-xl">Payment Processing</CardTitle>
                <CardDescription className="text-sm md:text-base">
                  Mobile money integration with Hubtel
                </CardDescription>
              </CardHeader>
            </Card>

            <Card className="border-2 hover:border-orange-500 transition-all hover:shadow-lg">
              <CardHeader>
                <div className="w-10 h-10 md:w-12 md:h-12 bg-orange-100 rounded-lg flex items-center justify-center mb-3 md:mb-4">
                  <ShoppingCart className="h-5 w-5 md:h-6 md:w-6 text-orange-600" />
                </div>
                <CardTitle className="text-lg md:text-xl">Inventory Tracking</CardTitle>
                <CardDescription className="text-sm md:text-base">
                  Track products and serial numbers
                </CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </section>

      {/* CTA Section for Mobile */}
      <section className="sm:hidden py-8 px-4">
        <div className="max-w-md mx-auto space-y-4">
          <Card className="border-2 hover:border-blue-500 transition-colors">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Admin Portal</CardTitle>
              <CardDescription className="text-sm">
                Manage your business operations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full"
                onClick={() => router.push("/admin-login")}
              >
                Admin Login
              </Button>
            </CardContent>
          </Card>

          <Card className="border-2 hover:border-green-500 transition-colors">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Customer Portal</CardTitle>
              <CardDescription className="text-sm">
                View contracts and make payments
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                className="w-full"
                onClick={() => router.push("/customer-login")}
              >
                Customer Login
              </Button>
              <Button
                className="w-full"
                variant="outline"
                onClick={() => router.push("/customer-activate")}
              >
                Activate Account
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-300 py-8 md:py-12 px-4 sm:px-6 lg:px-8 mt-8 md:mt-0">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 gap-6 md:gap-8 text-center md:text-left">
            <div>
              <div className="flex items-center justify-center md:justify-start mb-3 md:mb-4">
                <ShoppingCart className="h-5 w-5 md:h-6 md:w-6 text-blue-500" />
                <span className="ml-2 text-base md:text-lg font-bold text-white">
                  AIDOO TECH
                </span>
              </div>
              <p className="text-sm md:text-base text-gray-400">
                Modern hire purchase management system.
              </p>
            </div>
          </div>
          <div className="mt-6 md:mt-8 pt-6 md:pt-8 border-t border-gray-800 text-center">
            <p className="text-xs md:text-sm text-gray-400">
              &copy; 2025 AIDOO TECH. All rights reserved.
            </p>
            <p className="text-xs md:text-sm text-gray-400 mt-1">
              Developed By EYO Solutions
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

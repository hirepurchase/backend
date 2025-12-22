"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ShoppingCart, ArrowLeft, LogIn, AlertCircle } from "lucide-react";

export default function CustomerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${API_URL}/auth/customer/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Login failed");
      }

      const { token, user } = await response.json();

      // Store auth data
      if (typeof window !== 'undefined') {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        localStorage.setItem('userType', 'customer');
        window.location.href = '/customer/dashboard';
      }
    } catch (err: any) {
      setError(err.message || "Invalid credentials");
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-emerald-50 to-teal-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Back to Home Button */}
        <Button
          variant="ghost"
          className="mb-4 text-sm sm:text-base"
          onClick={() => router.push('/')}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Home
        </Button>

        <Card className="shadow-2xl border-0">
          <CardHeader className="space-y-3 sm:space-y-4 pb-4 sm:pb-6 px-4 sm:px-6">
            <div className="flex justify-center">
              <div className="w-14 h-14 sm:w-16 sm:h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center shadow-lg">
                <ShoppingCart className="h-7 w-7 sm:h-8 sm:w-8 text-white" />
              </div>
            </div>
            <div className="text-center">
              <CardTitle className="text-2xl sm:text-3xl font-bold text-gray-900">
                Customer Portal
              </CardTitle>
              <CardDescription className="text-sm sm:text-base mt-2">
                Sign in to view your contracts and make payments
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 sm:space-y-6 px-4 sm:px-6 pb-6">
            {/* Error Message */}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">{error}</AlertDescription>
              </Alert>
            )}

            {/* Login Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm sm:text-base">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  placeholder="your.email@example.com"
                  className="h-10 sm:h-11 text-sm sm:text-base"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm sm:text-base">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  placeholder="Enter your password"
                  className="h-10 sm:h-11 text-sm sm:text-base"
                />
              </div>

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full h-10 sm:h-11 text-sm sm:text-base bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700"
              >
                {isLoading ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 h-4 w-4" />
                    Sign In
                  </>
                )}
              </Button>
            </form>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-white px-2 text-gray-500">
                  Don't have an account?
                </span>
              </div>
            </div>

            {/* Activate Account Link */}
            <div className="text-center space-y-3">
              <p className="text-xs sm:text-sm text-gray-600">
                If you're a new customer, activate your account first
              </p>
              <Button
                variant="outline"
                className="w-full h-10 sm:h-11 text-sm sm:text-base"
                onClick={() => router.push('/customer-activate')}
              >
                Activate Your Account
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="mt-4 sm:mt-6 text-center text-xs sm:text-sm text-gray-600 px-4">
          <p>&copy; 2025 AIDOO TECH. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}

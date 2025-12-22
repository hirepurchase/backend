'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/useToast';
import { CheckCircle } from 'lucide-react';

export default function CustomerActivationPage() {
  const [step, setStep] = useState(1);
  const [membershipId, setMembershipId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { activateAccount } = useAuth();
  const router = useRouter();
  const { toast } = useToast();

  const handleVerifyMembership = (e: React.FormEvent) => {
    e.preventDefault();
    if (membershipId.length > 0) {
      setStep(2);
    }
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast({
        title: 'Error',
        description: 'Passwords do not match',
        variant: 'destructive',
      });
      return;
    }

    if (password.length < 8) {
      toast({
        title: 'Error',
        description: 'Password must be at least 8 characters',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    const result = await activateAccount(membershipId, email, password);

    if (result.success) {
      setStep(3);
      setTimeout(() => {
        router.push('/customer/dashboard');
      }, 2000);
    } else {
      toast({
        title: 'Activation Failed',
        description: result.error || 'Failed to activate account',
        variant: 'destructive',
      });
    }

    setIsLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-green-50 to-blue-100">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            Activate Your Account
          </CardTitle>
          <CardDescription className="text-center">
            {step === 1 && 'Enter your Membership ID to get started'}
            {step === 2 && 'Create your login credentials'}
            {step === 3 && 'Account activated successfully!'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Progress Indicator */}
          <div className="flex gap-2 mb-6">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`h-2 flex-1 rounded-full ${
                  s <= step ? 'bg-green-600' : 'bg-gray-200'
                }`}
              />
            ))}
          </div>

          {/* Step 1: Membership ID */}
          {step === 1 && (
            <form onSubmit={handleVerifyMembership} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="membershipId">Membership ID</Label>
                <Input
                  id="membershipId"
                  type="text"
                  placeholder="Enter your Membership ID"
                  value={membershipId}
                  onChange={(e) => setMembershipId(e.target.value)}
                  required
                  className="text-center font-mono text-lg"
                />
                <p className="text-xs text-gray-500 text-center">
                  This was provided when you were registered
                </p>
              </div>
              <Button type="submit" className="w-full">
                Continue
              </Button>
              <div className="text-center text-sm">
                <p className="text-gray-600">Already activated?</p>
                <a href="/customer/login" className="text-green-600 hover:underline font-medium">
                  Sign in here
                </a>
              </div>
            </form>
          )}

          {/* Step 2: Set Credentials */}
          {step === 2 && (
            <form onSubmit={handleActivate} className="space-y-4">
              <div className="bg-green-50 p-3 rounded-lg mb-4">
                <p className="text-sm font-medium text-green-900">Membership ID:</p>
                <p className="font-mono text-lg">{membershipId}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your.email@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Min. 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Re-enter your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(1)}
                  disabled={isLoading}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button type="submit" disabled={isLoading} className="flex-1">
                  {isLoading ? 'Activating...' : 'Activate Account'}
                </Button>
              </div>
            </form>
          )}

          {/* Step 3: Success */}
          {step === 3 && (
            <div className="text-center py-8">
              <CheckCircle className="h-16 w-16 mx-auto mb-4 text-green-600" />
              <h3 className="text-xl font-bold mb-2">Account Activated!</h3>
              <p className="text-gray-600 mb-4">
                Your account has been successfully activated.
              </p>
              <p className="text-sm text-gray-500">
                Redirecting to dashboard...
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

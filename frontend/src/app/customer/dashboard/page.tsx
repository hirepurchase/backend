'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function CustomerDashboardPage() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [upcomingPayments, setUpcomingPayments] = useState<any[]>([]);
  const [stats, setStats] = useState({
    totalContracts: 0,
    activeContracts: 0,
    totalOutstanding: 0,
    nextPaymentDue: null as any,
  });
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setIsLoading(true);

      // Load customer's contracts
      const contractsResponse = await api.get('/customers/me/contracts');
      const contractsData = contractsResponse.data.contracts || [];
      setContracts(contractsData);

      // Calculate stats
      const activeContracts = contractsData.filter((c: any) => c.status === 'ACTIVE');
      const totalOutstanding = contractsData.reduce(
        (sum: number, c: any) => sum + (c.outstandingBalance || 0),
        0
      );

      // Get upcoming installments
      const installmentsResponse = await api.get('/customers/me/installments/upcoming');
      const upcomingData = installmentsResponse.data.installments || [];
      setUpcomingPayments(upcomingData);

      setStats({
        totalContracts: contractsData.length,
        activeContracts: activeContracts.length,
        totalOutstanding,
        nextPaymentDue: upcomingData[0] || null,
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load dashboard data',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Welcome Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">Welcome to your customer portal</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Total Contracts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.totalContracts}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Active Contracts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">{stats.activeContracts}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
              <CreditCard className="h-4 w-4" />
              Total Outstanding
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-red-600">
              {formatCurrency(stats.totalOutstanding)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Next Payment
            </CardTitle>
          </CardHeader>
          <CardContent>
            {stats.nextPaymentDue ? (
              <>
                <p className="text-2xl font-bold">
                  {formatCurrency(stats.nextPaymentDue.amount)}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  Due: {formatDate(stats.nextPaymentDue.dueDate)}
                </p>
              </>
            ) : (
              <p className="text-gray-500">No upcoming payments</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Contracts */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Active Contracts</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/customer/contracts')}
              >
                View All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {contracts.filter((c) => c.status === 'ACTIVE').length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No active contracts</p>
              </div>
            ) : (
              <div className="space-y-4">
                {contracts
                  .filter((c) => c.status === 'ACTIVE')
                  .slice(0, 3)
                  .map((contract) => (
                    <div
                      key={contract.id}
                      className="p-4 border rounded-lg hover:bg-gray-50 cursor-pointer"
                      onClick={() => router.push(`/customer/contracts/${contract.id}`)}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium">{contract.contractNumber}</p>
                          <p className="text-sm text-gray-600 mt-1">
                            {contract.inventoryItem?.product?.name}
                          </p>
                          <p className="text-sm text-gray-500 mt-1">
                            {contract.paymentFrequency} • {contract.totalInstallments} installments
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-green-600">
                            {formatCurrency(contract.totalPaid)}
                          </p>
                          <p className="text-sm text-gray-600">
                            of {formatCurrency(contract.totalPrice)}
                          </p>
                          <p className="text-xs text-red-600 mt-1">
                            Outstanding: {formatCurrency(contract.outstandingBalance)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Payments */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Upcoming Payments</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/customer/payments')}
              >
                Make Payment
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {upcomingPayments.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No upcoming payments</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingPayments.slice(0, 5).map((inst: any) => (
                    <TableRow key={inst.id}>
                      <TableCell className="font-mono text-sm">
                        {inst.contract?.contractNumber}
                      </TableCell>
                      <TableCell>{formatDate(inst.dueDate)}</TableCell>
                      <TableCell className="font-medium">
                        {formatCurrency(inst.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusColor(inst.status)}>
                          {inst.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Button
              variant="outline"
              className="h-24 flex-col gap-2"
              onClick={() => router.push('/customer/payments')}
            >
              <CreditCard className="h-8 w-8" />
              <span>Make Payment</span>
            </Button>
            <Button
              variant="outline"
              className="h-24 flex-col gap-2"
              onClick={() => router.push('/customer/contracts')}
            >
              <FileText className="h-8 w-8" />
              <span>View Contracts</span>
            </Button>
            <Button
              variant="outline"
              className="h-24 flex-col gap-2"
              onClick={() => router.push('/customer/profile')}
            >
              <FileText className="h-8 w-8" />
              <span>Download Statement</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

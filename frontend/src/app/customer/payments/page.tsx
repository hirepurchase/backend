'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, DollarSign, FileText, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import api from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

interface Contract {
  id: string;
  contractNumber: string;
  status: string;
  totalPrice: number;
  totalPaid: number;
  outstandingBalance: number;
  inventoryItem: {
    product: {
      name: string;
    };
    serialNumber: string;
  };
  installments: Array<{
    id: string;
    status: string;
    amount: number;
    paidAmount: number;
  }>;
}

export default function CustomerPaymentsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    loadContracts();
  }, []);

  const loadContracts = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/customers/me/contracts');
      const allContracts = response.data.contracts || [];

      // Filter to only show active contracts
      const activeContracts = allContracts.filter(
        (c: Contract) => c.status === 'ACTIVE' && c.outstandingBalance > 0
      );

      setContracts(activeContracts);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load contracts',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getContractStats = () => {
    const totalOutstanding = contracts.reduce((sum, c) => sum + c.outstandingBalance, 0);
    const pendingInstallments = contracts.reduce((sum, c) =>
      sum + (c.installments?.filter(i => i.status === 'PENDING' || i.status === 'PARTIAL').length || 0), 0
    );
    const overdueInstallments = contracts.reduce((sum, c) =>
      sum + (c.installments?.filter(i => i.status === 'OVERDUE').length || 0), 0
    );

    return { totalOutstanding, pendingInstallments, overdueInstallments };
  };

  const stats = getContractStats();

  const getInstallmentStatusColor = (status: string) => {
    switch (status) {
      case 'PAID':
        return 'bg-green-100 text-green-800';
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800';
      case 'OVERDUE':
        return 'bg-red-100 text-red-800';
      case 'PARTIAL':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Make a Payment</h1>
        <p className="text-gray-600 mt-1">Select a contract to view installments and make a payment</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Outstanding</p>
                <p className="text-2xl font-bold text-blue-600">{formatCurrency(stats.totalOutstanding)}</p>
              </div>
              <DollarSign className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Pending Installments</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.pendingInstallments}</p>
              </div>
              <FileText className="h-8 w-8 text-yellow-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Overdue Installments</p>
                <p className="text-2xl font-bold text-red-600">{stats.overdueInstallments}</p>
              </div>
              <AlertCircle className="h-8 w-8 text-red-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Contracts List */}
      <Card>
        <CardHeader>
          <CardTitle>Your Active Contracts</CardTitle>
        </CardHeader>
        <CardContent>
          {contracts.length === 0 ? (
            <div className="text-center py-12">
              <CreditCard className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600 mb-2">No active contracts with outstanding balance</p>
              <p className="text-sm text-gray-500">All your payments are up to date!</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract Number</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Serial Number</TableHead>
                    <TableHead>Total Price</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead>Outstanding</TableHead>
                    <TableHead>Installments</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contracts.map((contract) => {
                    const pendingCount = contract.installments?.filter(
                      i => i.status === 'PENDING' || i.status === 'PARTIAL'
                    ).length || 0;
                    const overdueCount = contract.installments?.filter(
                      i => i.status === 'OVERDUE'
                    ).length || 0;

                    return (
                      <TableRow key={contract.id}>
                        <TableCell className="font-medium">{contract.contractNumber}</TableCell>
                        <TableCell>{contract.inventoryItem?.product?.name || 'N/A'}</TableCell>
                        <TableCell className="text-xs font-mono">
                          {contract.inventoryItem?.serialNumber || 'N/A'}
                        </TableCell>
                        <TableCell>{formatCurrency(contract.totalPrice)}</TableCell>
                        <TableCell className="text-green-600">
                          {formatCurrency(contract.totalPaid)}
                        </TableCell>
                        <TableCell className="text-orange-600 font-semibold">
                          {formatCurrency(contract.outstandingBalance)}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            {overdueCount > 0 && (
                              <Badge className="bg-red-100 text-red-800">
                                {overdueCount} Overdue
                              </Badge>
                            )}
                            {pendingCount > 0 && (
                              <Badge className="bg-yellow-100 text-yellow-800">
                                {pendingCount} Pending
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            onClick={() => router.push(`/customer/payments/${contract.id}`)}
                          >
                            <CreditCard className="h-4 w-4 mr-2" />
                            Pay Now
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

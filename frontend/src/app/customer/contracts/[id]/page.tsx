'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Download, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency, formatDate, getStatusColor, calculateProgress } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function CustomerContractDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [contract, setContract] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadContract();
  }, [params.id]);

  const loadContract = async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/customers/me/contracts/${params.id}`);
      setContract(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load contract',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadStatement = async () => {
    try {
      const response = await api.get(`/customers/me/contracts/${params.id}/statement`, {
        responseType: 'blob',
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `statement-${contract.contractNumber}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();

      toast({
        title: 'Success',
        description: 'Statement downloaded successfully',
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to download statement',
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="p-8">
        <div className="text-center py-12">
          <p className="text-gray-500">Contract not found</p>
          <Button className="mt-4" onClick={() => router.push('/customer/contracts')}>
            Back to Contracts
          </Button>
        </div>
      </div>
    );
  }

  const progress = calculateProgress(contract.totalPaid, contract.totalPrice);

  return (
    <div className="p-8">
      <Button variant="outline" onClick={() => router.back()} className="mb-6">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>

      {/* Contract Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">Contract {contract.contractNumber}</h1>
            <p className="text-gray-600 mt-1">Hire purchase agreement details</p>
          </div>
          <Badge className={getStatusColor(contract.status)} style={{ fontSize: '1rem', padding: '0.5rem 1rem' }}>
            {contract.status}
          </Badge>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600">Total Price</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{formatCurrency(contract.totalPrice)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600">Total Paid</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{formatCurrency(contract.totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600">Outstanding</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-red-600">
              {formatCurrency(contract.outstandingBalance)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-600">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-2">
              <p className="text-2xl font-bold">{progress.toFixed(0)}%</p>
              <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-green-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Product Info */}
          <Card>
            <CardHeader>
              <CardTitle>Product Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Product</p>
                  <p className="font-medium">{contract.inventoryItem?.product?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Category</p>
                  <p className="font-medium">{contract.inventoryItem?.product?.category?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Serial/IMEI</p>
                  <p className="font-medium font-mono">{contract.inventoryItem?.serialNumber}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Ownership Transferred</p>
                  <Badge variant={contract.ownershipTransferred ? 'default' : 'secondary'}>
                    {contract.ownershipTransferred ? 'Yes' : 'No'}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Installment Schedule */}
          <Card>
            <CardHeader>
              <CardTitle>Installment Schedule</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Due Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contract.installments?.map((inst: any) => (
                    <TableRow key={inst.id}>
                      <TableCell>{inst.installmentNo}</TableCell>
                      <TableCell>{formatDate(inst.dueDate)}</TableCell>
                      <TableCell>{formatCurrency(inst.amount)}</TableCell>
                      <TableCell className="text-green-600">
                        {formatCurrency(inst.paidAmount)}
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusColor(inst.status)}>{inst.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Payment History */}
          <Card>
            <CardHeader>
              <CardTitle>Payment History</CardTitle>
            </CardHeader>
            <CardContent>
              {contract.payments?.length === 0 ? (
                <p className="text-center py-8 text-gray-500">No payments yet</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Transaction Ref</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contract.payments?.map((payment: any) => (
                      <TableRow key={payment.id}>
                        <TableCell className="font-mono text-sm">
                          {payment.transactionRef}
                        </TableCell>
                        <TableCell>{formatCurrency(payment.amount)}</TableCell>
                        <TableCell>{payment.paymentMethod}</TableCell>
                        <TableCell>{formatDate(payment.paymentDate)}</TableCell>
                        <TableCell>
                          <Badge className={getStatusColor(payment.status)}>
                            {payment.status}
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

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Contract Terms */}
          <Card>
            <CardHeader>
              <CardTitle>Contract Terms</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-gray-600">Payment Frequency</p>
                <p className="font-medium">{contract.paymentFrequency}</p>
              </div>
              <div>
                <p className="text-gray-600">Installment Amount</p>
                <p className="font-medium">{formatCurrency(contract.installmentAmount)}</p>
              </div>
              <div>
                <p className="text-gray-600">Total Installments</p>
                <p className="font-medium">{contract.totalInstallments}</p>
              </div>
              <div>
                <p className="text-gray-600">Start Date</p>
                <p className="font-medium">{formatDate(contract.startDate)}</p>
              </div>
              <div>
                <p className="text-gray-600">End Date</p>
                <p className="font-medium">{formatDate(contract.endDate)}</p>
              </div>
              <div>
                <p className="text-gray-600">Grace Period</p>
                <p className="font-medium">{contract.gracePeriodDays} days</p>
              </div>
              <div>
                <p className="text-gray-600">Penalty Rate</p>
                <p className="font-medium">{contract.penaltyPercentage}%</p>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={handleDownloadStatement}
              >
                <Download className="mr-2 h-4 w-4" />
                Download Statement
              </Button>
              <Button
                className="w-full bg-green-600 hover:bg-green-700"
                onClick={() => router.push('/customer/payments')}
              >
                <CreditCard className="mr-2 h-4 w-4" />
                Make Payment
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

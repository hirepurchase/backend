'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Mail, Phone, MapPin, Calendar, CreditCard, FileText, User, Download, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import api from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function CustomerStatementPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [statement, setStatement] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadStatement();
  }, [params.id]);

  const loadStatement = async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/customers/${params.id}/statement`);
      setStatement(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load customer statement',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'GOOD_STANDING':
        return 'default';
      case 'OVERDUE':
        return 'destructive';
      case 'DEFAULTED':
        return 'destructive';
      case 'COMPLETED':
        return 'secondary';
      default:
        return 'secondary';
    }
  };

  const getContractStatusColor = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return 'bg-green-100 text-green-800';
      case 'COMPLETED':
        return 'bg-blue-100 text-blue-800';
      case 'DEFAULTED':
        return 'bg-red-100 text-red-800';
      case 'CANCELLED':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

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

  if (!statement) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <p className="text-gray-600 mb-4">Customer not found</p>
        <Button onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Go Back
        </Button>
      </div>
    );
  }

  const { customer, summary, contracts, paymentHistory } = statement;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 print:hidden">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <h1 className="text-3xl font-bold">Customer Statement</h1>
        </div>
        <Button onClick={handlePrint}>
          <Printer className="h-4 w-4 mr-2" />
          Print Statement
        </Button>
      </div>

      {/* Customer Information Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Customer Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Customer Photo */}
            {customer.photoUrl && (
              <div className="flex-shrink-0">
                <div className="w-32 h-32 rounded-lg overflow-hidden border-2 border-gray-200">
                  <img
                    src={customer.photoUrl}
                    alt={`${customer.firstName} ${customer.lastName}`}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgdmlld0JveD0iMCAwIDEyOCAxMjgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIGZpbGw9IiNFNUU3RUIiLz48cGF0aCBkPSJNNjQgNjRDNzQuMDQ1NyA2NCA4Mi4zMzMzIDU1LjcxMjggODIuMzMzMyA0NS42NjY3Qzg0LjMzMzMgMzUuNjIwNSA3NC4wNDU3IDI3LjMzMzMgNjQgMjcuMzMzM0M1My45NTQzIDI3LjMzMzMgNDUuNjY2NyAzNS42MjA1IDQ1LjY2NjcgNDUuNjY2N0M0NS42NjY3IDU1LjcxMjggNTMuOTU0MyA2NCA2NCA2NFpNNjQgNzMuMzMzM0M1MC41IDczLjMzMzMgMzYgODAuMzMzMyAzNiA5My4zMzMzVjEwMC42NjdIOTJWOTMuMzMzM0M5MiA4MC4zMzMzIDc3LjUgNzMuMzMzMyA2NCA3My4zMzMzWiIgZmlsbD0iIzlDQTNCOCIvPjwvc3ZnPg==';
                    }}
                  />
                </div>
              </div>
            )}

            {/* Customer Details */}
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div>
                <p className="text-sm text-gray-600">Membership ID</p>
                <p className="font-semibold text-lg">{customer.membershipId}</p>
              </div>
              <div>
                <p className="text-sm text-gray-600">Full Name</p>
                <p className="font-semibold">{customer.firstName} {customer.lastName}</p>
              </div>
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-gray-600" />
              <div>
                <p className="text-sm text-gray-600">Phone</p>
                <p className="font-semibold">{customer.phone}</p>
              </div>
            </div>
            {customer.email && (
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-gray-600" />
                <div>
                  <p className="text-sm text-gray-600">Email</p>
                  <p className="font-semibold">{customer.email}</p>
                </div>
              </div>
            )}
            {customer.address && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-gray-600" />
                <div>
                  <p className="text-sm text-gray-600">Address</p>
                  <p className="font-semibold">{customer.address}</p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-600" />
              <div>
                <p className="text-sm text-gray-600">Registered On</p>
                <p className="font-semibold">{formatDate(customer.createdAt)}</p>
              </div>
            </div>
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <Badge variant={customer.isActivated ? 'default' : 'secondary'}>
                {customer.isActivated ? 'Active' : 'Pending Activation'}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-gray-600">Account Status</p>
              <Badge variant={getStatusBadgeVariant(summary.accountStatus)}>
                {summary.accountStatus.replace('_', ' ')}
              </Badge>
            </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Financial Summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Total Contract Value</p>
            <p className="text-2xl font-bold text-blue-600">{formatCurrency(summary.totalContractValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Total Paid</p>
            <p className="text-2xl font-bold text-green-600">{formatCurrency(summary.totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Outstanding Balance</p>
            <p className="text-2xl font-bold text-orange-600">{formatCurrency(summary.totalOutstanding)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Overdue Amount</p>
            <p className="text-2xl font-bold text-red-600">{formatCurrency(summary.totalOverdue)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Contracts Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Active Contracts</p>
            <p className="text-3xl font-bold">{summary.activeContracts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Completed Contracts</p>
            <p className="text-3xl font-bold">{summary.completedContracts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-gray-600 mb-2">Total Contracts</p>
            <p className="text-3xl font-bold">{summary.totalContracts}</p>
          </CardContent>
        </Card>
      </div>

      {/* Contracts Details */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Contracts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {contracts.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No contracts found</p>
          ) : (
            contracts.map((contract: any) => (
              <Card key={contract.id} className="mb-4">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">Contract #{contract.contractNumber}</CardTitle>
                      <p className="text-sm text-gray-600">
                        {contract.inventoryItem?.product?.name || 'N/A'}
                      </p>
                    </div>
                    <Badge className={getContractStatusColor(contract.status)}>
                      {contract.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-gray-600">Total Price</p>
                      <p className="font-semibold">{formatCurrency(contract.totalPrice)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Total Paid</p>
                      <p className="font-semibold text-green-600">{formatCurrency(contract.totalPaid)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Outstanding</p>
                      <p className="font-semibold text-orange-600">{formatCurrency(contract.outstandingBalance)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">Start Date</p>
                      <p className="font-semibold">{formatDate(contract.startDate)}</p>
                    </div>
                  </div>

                  {/* Installment Schedule */}
                  <div className="mt-4">
                    <h4 className="font-semibold mb-2">Installment Schedule</h4>
                    <div className="overflow-x-auto">
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
                          {contract.installments.map((installment: any) => (
                            <TableRow key={installment.id}>
                              <TableCell>{installment.installmentNo}</TableCell>
                              <TableCell>{formatDate(installment.dueDate)}</TableCell>
                              <TableCell>{formatCurrency(installment.amount)}</TableCell>
                              <TableCell className="text-green-600">
                                {formatCurrency(installment.paidAmount)}
                              </TableCell>
                              <TableCell>
                                <Badge className={getInstallmentStatusColor(installment.status)}>
                                  {installment.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </CardContent>
      </Card>

      {/* Payment History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Payment History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {paymentHistory.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No payment history</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Transaction Ref</TableHead>
                    <TableHead>Contract</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentHistory.map((payment: any) => (
                    <TableRow key={payment.id}>
                      <TableCell>{formatDate(payment.createdAt)}</TableCell>
                      <TableCell className="font-mono text-sm">{payment.transactionRef}</TableCell>
                      <TableCell>{payment.contract?.contractNumber || 'N/A'}</TableCell>
                      <TableCell className="font-semibold">{formatCurrency(payment.amount)}</TableCell>
                      <TableCell>{payment.paymentMethod}</TableCell>
                      <TableCell>
                        <Badge variant={payment.status === 'SUCCESS' ? 'default' : 'secondary'}>
                          {payment.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

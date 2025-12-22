'use client';

import { useEffect, useState, useMemo } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useRouter } from 'next/navigation';
import { ExportButtons } from '@/components/admin/ExportButtons';
import { ExportOptions } from '@/lib/exportUtils';

export default function PaymentReportPage() {
  const [report, setReport] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [filters, setFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    status: '',
  });
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    loadReport();
    // Reset to first page when filters change
    setCurrentPage(1);
  }, [filters]);

  const loadReport = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/reports/payments', {
        params: filters,
      });
      setReport(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load payment report',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Pagination calculations
  const payments = report?.payments || [];
  const totalPages = Math.ceil(payments.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedPayments = payments.slice(startIndex, endIndex);

  const handlePreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return <Badge className="bg-green-600">Success</Badge>;
      case 'FAILED':
        return <Badge variant="destructive">Failed</Badge>;
      case 'PENDING':
        return <Badge className="bg-yellow-600">Pending</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const exportOptions = useMemo<ExportOptions>(() => {
    if (!report) {
      return {
        title: 'Payment Report',
        filename: 'payment-report',
        columns: [],
        data: [],
      };
    }

    return {
      title: 'Payment Report',
      filename: `payment-report-${filters.startDate}-to-${filters.endDate}`,
      dateRange: {
        start: formatDate(filters.startDate),
        end: formatDate(filters.endDate),
      },
      summary: [
        { label: 'Total Transactions', value: report.summary?.totalTransactions || 0 },
        { label: 'Successful', value: report.summary?.successfulTransactions || 0 },
        { label: 'Failed', value: report.summary?.failedTransactions || 0 },
        { label: 'Total Collected', value: formatCurrency(report.summary?.totalAmountCollected || 0) },
      ],
      columns: [
        { header: 'Date', accessor: (row: any) => formatDate(row.createdAt), align: 'left' },
        { header: 'Transaction Ref', accessor: 'transactionRef', align: 'left' },
        { header: 'Contract #', accessor: (row: any) => row.contract?.contractNumber || '-', align: 'left' },
        { header: 'Customer', accessor: (row: any) => `${row.customer?.firstName || ''} ${row.customer?.lastName || ''}`, align: 'left' },
        { header: 'Amount', accessor: (row: any) => formatCurrency(row.amount), align: 'right' },
        { header: 'Method', accessor: 'paymentMethod', align: 'left' },
        { header: 'Status', accessor: 'status', align: 'left' },
      ],
      data: report.payments || [],
    };
  }, [report, filters]);

  if (isLoading) {
    return (
      <div className="p-8 flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Payment Report</h1>
            <p className="text-gray-600 mt-1">Payment collections and transaction analysis</p>
          </div>
        </div>
        <ExportButtons exportOptions={exportOptions} />
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Start Date</label>
              <Input
                type="date"
                value={filters.startDate}
                onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">End Date</label>
              <Input
                type="date"
                value={filters.endDate}
                onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Status</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="">All Status</option>
                <option value="SUCCESS">Success</option>
                <option value="FAILED">Failed</option>
                <option value="PENDING">Pending</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button onClick={loadReport}>
              Generate Report
            </Button>
            <Button
              variant="outline"
              onClick={() => setFilters({
                startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
                endDate: new Date().toISOString().split('T')[0],
                status: '',
              })}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Transactions</p>
              <p className="text-2xl font-bold mt-1">{report?.summary?.totalTransactions || 0}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Successful</p>
              <p className="text-2xl font-bold mt-1 text-green-600">
                {report?.summary?.successfulTransactions || 0}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Failed</p>
              <p className="text-2xl font-bold mt-1 text-red-600">
                {report?.summary?.failedTransactions || 0}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Collected</p>
              <p className="text-2xl font-bold mt-1 text-blue-600">
                {formatCurrency(report?.summary?.totalAmountCollected || 0)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Payment Method Breakdown */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Payment Method Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">MTN Mobile Money</p>
              <p className="text-xl font-bold text-yellow-600 mt-1">
                {formatCurrency(report?.summary?.byProvider?.MTN || 0)}
              </p>
            </div>
            <div className="text-center p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">Vodafone Cash</p>
              <p className="text-xl font-bold text-red-600 mt-1">
                {formatCurrency(report?.summary?.byProvider?.VODAFONE || 0)}
              </p>
            </div>
            <div className="text-center p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">AirtelTigo Money</p>
              <p className="text-xl font-bold text-blue-600 mt-1">
                {formatCurrency(report?.summary?.byProvider?.AIRTELTIGO || 0)}
              </p>
            </div>
            <div className="text-center p-4 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">Other Methods</p>
              <p className="text-xl font-bold text-gray-600 mt-1">
                {formatCurrency(report?.summary?.byProvider?.OTHER || 0)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Payment Transactions */}
      <Card>
        <CardHeader>
          <CardTitle>Payment Transactions ({payments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <DollarSign className="h-16 w-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No transactions found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Transaction Ref</TableHead>
                      <TableHead>Contract #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedPayments.map((payment: any) => (
                      <TableRow key={payment.id}>
                        <TableCell className="text-sm">{formatDate(payment.createdAt)}</TableCell>
                        <TableCell className="font-mono text-sm">{payment.transactionRef}</TableCell>
                        <TableCell className="text-sm">
                          {payment.contract?.contractNumber || '-'}
                        </TableCell>
                        <TableCell>
                          {payment.customer?.firstName} {payment.customer?.lastName}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(payment.amount)}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {payment.paymentMethod}
                            {payment.mobileMoneyProvider && (
                              <span className="text-xs text-gray-500 ml-1">
                                ({payment.mobileMoneyProvider})
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(payment.status)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {payments.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-600">
                    Showing {startIndex + 1} to {Math.min(endIndex, payments.length)} of {payments.length} transactions
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePreviousPage}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Previous
                    </Button>
                    <div className="text-sm text-gray-600">
                      Page {currentPage} of {totalPages}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleNextPage}
                      disabled={currentPage === totalPages}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

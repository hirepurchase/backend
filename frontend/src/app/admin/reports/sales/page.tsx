'use client';

import { useEffect, useState, useMemo } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
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

export default function SalesReportPage() {
  const [report, setReport] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [filters, setFilters] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
    productId: '',
    agentId: '',
  });
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    loadProducts();
    loadAgents();
  }, []);

  useEffect(() => {
    loadReport();
    // Reset to first page when filters change
    setCurrentPage(1);
  }, [filters]);

  const loadProducts = async () => {
    try {
      const response = await api.get('/products', {
        params: { limit: 1000 } // Increase limit to show all products
      });
      setProducts(response.data.products || []);
    } catch (error: any) {
      console.error('Failed to load products:', error);
    }
  };

  const loadAgents = async () => {
    try {
      const response = await api.get('/users');
      const allUsers = response.data.users || [];
      // Filter only sales agents
      const salesAgents = allUsers.filter((u: any) => u.role === 'ADMIN' || u.role === 'AGENT');
      setAgents(salesAgents);
    } catch (error: any) {
      console.error('Failed to load agents:', error);
    }
  };

  const loadReport = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/reports/sales', {
        params: filters,
      });
      setReport(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load sales report',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Pagination calculations
  const contracts = report?.contracts || [];
  const totalPages = Math.ceil(contracts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedContracts = contracts.slice(startIndex, endIndex);

  const handlePreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const exportOptions = useMemo<ExportOptions>(() => {
    if (!report) {
      return {
        title: 'Sales Report',
        filename: 'sales-report',
        columns: [],
        data: [],
      };
    }

    return {
      title: 'Sales Report',
      filename: `sales-report-${filters.startDate}-to-${filters.endDate}`,
      dateRange: {
        start: formatDate(filters.startDate),
        end: formatDate(filters.endDate),
      },
      summary: [
        { label: 'Total Contracts', value: report.summary?.totalContracts || 0 },
        { label: 'Total Sales Value', value: formatCurrency(report.summary?.totalSalesValue || 0) },
        { label: 'Total Deposits', value: formatCurrency(report.summary?.totalDeposits || 0) },
        { label: 'Average Contract Value', value: formatCurrency(report.summary?.averageContractValue || 0) },
      ],
      columns: [
        { header: 'Date', accessor: (row: any) => formatDate(row.createdAt), align: 'left' },
        { header: 'Contract #', accessor: 'contractNumber', align: 'left' },
        { header: 'Customer', accessor: (row: any) => `${row.customer?.firstName || ''} ${row.customer?.lastName || ''}`, align: 'left' },
        { header: 'Product', accessor: (row: any) => row.inventoryItem?.product?.name || '-', align: 'left' },
        { header: 'Total Price', accessor: (row: any) => formatCurrency(row.totalPrice), align: 'right' },
        { header: 'Deposit', accessor: (row: any) => formatCurrency(row.depositAmount), align: 'right' },
        { header: 'Status', accessor: 'status', align: 'left' },
      ],
      data: report.contracts || [],
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
            <h1 className="text-3xl font-bold text-gray-900">Sales Report</h1>
            <p className="text-gray-600 mt-1">Contract sales and performance analysis</p>
          </div>
        </div>
        <ExportButtons exportOptions={exportOptions} />
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
              <label className="block text-sm font-medium mb-2">Product</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.productId}
                onChange={(e) => setFilters({ ...filters, productId: e.target.value })}
              >
                <option value="">All Products</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>{product.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Sales Agent</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.agentId}
                onChange={(e) => setFilters({ ...filters, agentId: e.target.value })}
              >
                <option value="">All Agents</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.firstName} {agent.lastName}
                  </option>
                ))}
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
                productId: '',
                agentId: '',
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
              <p className="text-sm text-gray-600">Total Contracts</p>
              <p className="text-2xl font-bold mt-1">{report?.summary?.totalContracts || 0}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Sales Value</p>
              <p className="text-2xl font-bold mt-1 text-green-600">
                {formatCurrency(report?.summary?.totalSalesValue || 0)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Deposits</p>
              <p className="text-2xl font-bold mt-1 text-blue-600">
                {formatCurrency(report?.summary?.totalDeposits || 0)}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Average Contract</p>
              <p className="text-2xl font-bold mt-1">
                {formatCurrency(report?.summary?.averageContractValue || 0)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Sales Contracts */}
      <Card>
        <CardHeader>
          <CardTitle>Sales Contracts ({contracts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {contracts.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p className="text-lg font-medium">No contracts found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Contract #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Total Price</TableHead>
                      <TableHead className="text-right">Deposit</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedContracts.map((contract: any) => (
                      <TableRow key={contract.id}>
                        <TableCell className="text-sm">{formatDate(contract.createdAt)}</TableCell>
                        <TableCell className="font-mono text-sm">{contract.contractNumber}</TableCell>
                        <TableCell>
                          {contract.customer?.firstName} {contract.customer?.lastName}
                        </TableCell>
                        <TableCell>{contract.inventoryItem?.product?.name || '-'}</TableCell>
                        <TableCell className="text-sm">
                          {contract.createdBy?.firstName} {contract.createdBy?.lastName}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(contract.totalPrice)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(contract.depositAmount)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={contract.status === 'ACTIVE' ? 'default' : 'secondary'}>
                            {contract.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {contracts.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-600">
                    Showing {startIndex + 1} to {Math.min(endIndex, contracts.length)} of {contracts.length} contracts
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

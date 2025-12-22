'use client';

import { useEffect, useState, useMemo } from 'react';
import { ArrowLeft, Users, FileText, Package, DollarSign, AlertTriangle, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useRouter } from 'next/navigation';
import { ExportButtons } from '@/components/admin/ExportButtons';
import { ExportOptions } from '@/lib/exportUtils';

export default function DashboardStatsPage() {
  const [stats, setStats] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/reports/dashboard');
      setStats(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load dashboard statistics',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const exportOptions = useMemo<ExportOptions>(() => {
    if (!stats) {
      return {
        title: 'Dashboard Overview',
        filename: 'dashboard-overview',
        columns: [],
        data: [],
      };
    }

    return {
      title: 'Dashboard Overview',
      filename: `dashboard-overview-${new Date().toISOString().split('T')[0]}`,
      summary: [
        { label: 'Total Customers', value: stats.customers?.total || 0 },
        { label: 'Total Contracts', value: stats.contracts?.total || 0 },
        { label: 'Active Contracts', value: stats.contracts?.active || 0 },
        { label: 'Available Inventory', value: stats.inventory?.availableItems || 0 },
        { label: 'Overdue Installments', value: stats.alerts?.overdueInstallments || 0 },
        { label: 'This Month Collections', value: formatCurrency(stats.payments?.monthlyTotal || 0) },
        { label: 'This Week Collections', value: formatCurrency(stats.payments?.weeklyTotal || 0) },
      ],
      columns: [
        { header: 'Date', accessor: (row: any) => formatDate(row.createdAt), align: 'left' },
        { header: 'Contract #', accessor: 'contractNumber', align: 'left' },
        { header: 'Customer', accessor: (row: any) => `${row.customer?.firstName || ''} ${row.customer?.lastName || ''}`, align: 'left' },
        { header: 'Product', accessor: (row: any) => row.inventoryItem?.product?.name || '-', align: 'left' },
        { header: 'Total Price', accessor: (row: any) => formatCurrency(row.totalPrice), align: 'right' },
        { header: 'Status', accessor: 'status', align: 'left' },
      ],
      data: stats.recentContracts || [],
    };
  }, [stats]);

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
            <h1 className="text-3xl font-bold text-gray-900">Dashboard Overview</h1>
            <p className="text-gray-600 mt-1">Business metrics at a glance</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={loadStats}>
            Refresh
          </Button>
          <ExportButtons exportOptions={exportOptions} />
        </div>
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Customers</p>
                <p className="text-3xl font-bold mt-2">{stats?.customers?.total || 0}</p>
              </div>
              <div className="p-3 bg-blue-100 rounded-lg">
                <Users className="h-8 w-8 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Contracts</p>
                <p className="text-3xl font-bold mt-2">{stats?.contracts?.total || 0}</p>
                <p className="text-xs text-green-600 mt-1">
                  {stats?.contracts?.active || 0} active
                </p>
              </div>
              <div className="p-3 bg-green-100 rounded-lg">
                <FileText className="h-8 w-8 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Available Inventory</p>
                <p className="text-3xl font-bold mt-2">{stats?.inventory?.availableItems || 0}</p>
                <p className="text-xs text-gray-600 mt-1">
                  {stats?.inventory?.totalProducts || 0} products
                </p>
              </div>
              <div className="p-3 bg-purple-100 rounded-lg">
                <Package className="h-8 w-8 text-purple-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Overdue Installments</p>
                <p className="text-3xl font-bold mt-2 text-red-600">
                  {stats?.alerts?.overdueInstallments || 0}
                </p>
              </div>
              <div className="p-3 bg-red-100 rounded-lg">
                <AlertTriangle className="h-8 w-8 text-red-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Payment Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">This Month's Collections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Total Collected</p>
                  <p className="text-2xl font-bold text-green-600">
                    {formatCurrency(stats?.payments?.monthlyTotal || 0)}
                  </p>
                </div>
                <DollarSign className="h-12 w-12 text-green-600" />
              </div>
              <div className="pt-3 border-t">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total Transactions</span>
                  <span className="font-medium">{stats?.payments?.monthlyCount || 0}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">This Week's Collections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Total Collected</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {formatCurrency(stats?.payments?.weeklyTotal || 0)}
                  </p>
                </div>
                <TrendingUp className="h-12 w-12 text-blue-600" />
              </div>
              <div className="pt-3 border-t">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total Transactions</span>
                  <span className="font-medium">{stats?.payments?.weeklyCount || 0}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Contracts */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Contracts</CardTitle>
        </CardHeader>
        <CardContent>
          {stats?.recentContracts?.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p>No recent contracts</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Contract #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Total Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats?.recentContracts?.map((contract: any) => (
                  <TableRow key={contract.id}>
                    <TableCell className="text-sm">
                      {formatDate(contract.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {contract.contractNumber}
                    </TableCell>
                    <TableCell>
                      {contract.customer?.firstName} {contract.customer?.lastName}
                    </TableCell>
                    <TableCell>
                      {contract.inventoryItem?.product?.name || '-'}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(contract.totalPrice)}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}

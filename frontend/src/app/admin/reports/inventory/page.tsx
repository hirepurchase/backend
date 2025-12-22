'use client';

import { useEffect, useState, useMemo } from 'react';
import { ArrowLeft, Package, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useRouter } from 'next/navigation';
import { ExportButtons } from '@/components/admin/ExportButtons';
import { ExportOptions } from '@/lib/exportUtils';

export default function InventoryReportPage() {
  const [report, setReport] = useState<any>(null);
  const [categories, setCategories] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const [filters, setFilters] = useState({
    categoryId: '',
    status: '',
  });
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    loadCategories();
  }, []);

  useEffect(() => {
    loadReport();
    // Reset to first page when filters change
    setCurrentPage(1);
  }, [filters]);

  const loadCategories = async () => {
    try {
      const response = await api.get('/products/categories');
      const categoriesData = Array.isArray(response.data)
        ? response.data
        : (response.data?.categories || []);
      setCategories(categoriesData);
    } catch (error: any) {
      console.error('Failed to load categories:', error);
    }
  };

  const loadReport = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/reports/inventory', {
        params: {
          categoryId: filters.categoryId || undefined,
          status: filters.status || undefined,
        },
      });
      setReport(response.data);
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load inventory report',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Pagination calculations
  const inventoryItems = report?.inventory || [];
  const totalPages = Math.ceil(inventoryItems.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedInventory = inventoryItems.slice(startIndex, endIndex);

  const handlePreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
  };

  const exportOptions = useMemo<ExportOptions>(() => {
    if (!report) {
      return {
        title: 'Inventory Report',
        filename: 'inventory-report',
        columns: [],
        data: [],
      };
    }

    return {
      title: 'Inventory Report',
      filename: `inventory-report-${new Date().toISOString().split('T')[0]}`,
      summary: [
        { label: 'Total Products', value: report.summary?.totalProducts || 0 },
        { label: 'Total Items', value: report.summary?.totalItems || 0 },
        { label: 'Available Items', value: report.summary?.availableItems || 0 },
        { label: 'Stock Value', value: formatCurrency(report.summary?.totalStockValue || 0) },
      ],
      columns: [
        { header: 'Product', accessor: (row: any) => row.product.name, align: 'left' },
        { header: 'Category', accessor: (row: any) => row.product.category, align: 'left' },
        { header: 'Unit Price', accessor: (row: any) => formatCurrency(row.product.basePrice), align: 'right' },
        { header: 'Total Items', accessor: (row: any) => row.inventory.total, align: 'right' },
        { header: 'Available', accessor: (row: any) => row.inventory.available, align: 'right' },
        { header: 'Sold', accessor: (row: any) => row.inventory.sold, align: 'right' },
        { header: 'Reserved', accessor: (row: any) => row.inventory.reserved, align: 'right' },
        { header: 'Stock Value', accessor: (row: any) => formatCurrency(row.stockValue), align: 'right' },
        { header: 'Status', accessor: (row: any) => row.product.isActive ? 'Active' : 'Inactive', align: 'left' },
      ],
      data: report.inventory || [],
    };
  }, [report]);

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
            <h1 className="text-3xl font-bold text-gray-900">Inventory Report</h1>
            <p className="text-gray-600 mt-1">Stock levels and inventory valuation</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={loadReport}>
            Refresh
          </Button>
          <ExportButtons exportOptions={exportOptions} />
        </div>
      </div>

      {/* Filters */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Category</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.categoryId}
                onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}
              >
                <option value="">All Categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Status</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={filters.status}
                onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              >
                <option value="">All Status</option>
                <option value="AVAILABLE">Available</option>
                <option value="SOLD">Sold</option>
                <option value="RESERVED">Reserved</option>
              </select>
            </div>

            <div className="flex items-end">
              <Button
                variant="outline"
                onClick={() => setFilters({ categoryId: '', status: '' })}
                className="w-full"
              >
                Clear Filters
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Products</p>
              <p className="text-2xl font-bold mt-1">{report?.summary?.totalProducts || 0}</p>
              <p className="text-xs text-green-600 mt-1">
                {report?.summary?.activeProducts || 0} active
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Total Items</p>
              <p className="text-2xl font-bold mt-1">{report?.summary?.totalItems || 0}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Available Items</p>
              <p className="text-2xl font-bold mt-1 text-green-600">
                {report?.summary?.availableItems || 0}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div>
              <p className="text-sm text-gray-600">Stock Value</p>
              <p className="text-2xl font-bold mt-1 text-blue-600">
                {formatCurrency(report?.summary?.totalStockValue || 0)}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stock Alerts */}
      {(report?.summary?.lowStock?.length > 0 || report?.summary?.outOfStock?.length > 0) && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-orange-600">
              <AlertCircle className="h-5 w-5" />
              Stock Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {report?.summary?.outOfStock?.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-red-600 mb-2">
                    Out of Stock ({report.summary.outOfStock.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {report.summary.outOfStock.map((item: any) => (
                      <Badge key={item.product.id} variant="destructive">
                        {item.product.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {report?.summary?.lowStock?.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-orange-600 mb-2">
                    Low Stock - Less than 5 items ({report.summary.lowStock.length})
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {report.summary.lowStock.map((item: any) => (
                      <Badge key={item.product.id} className="bg-orange-100 text-orange-800">
                        {item.product.name} ({item.inventory.available})
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Inventory Details */}
      <Card>
        <CardHeader>
          <CardTitle>Inventory by Product ({inventoryItems.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {inventoryItems.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Package className="h-16 w-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No inventory found</p>
              <p className="text-sm mt-1">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Unit Price</TableHead>
                      <TableHead className="text-right">Total Items</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right">Sold</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Stock Value</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedInventory.map((item: any) => (
                      <TableRow key={item.product.id}>
                        <TableCell className="font-medium">{item.product.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{item.product.category}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(item.product.basePrice)}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {item.inventory.total}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="text-green-600 font-medium">
                            {item.inventory.available}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-gray-600">
                          {item.inventory.sold}
                        </TableCell>
                        <TableCell className="text-right text-yellow-600">
                          {item.inventory.reserved}
                        </TableCell>
                        <TableCell className="text-right font-medium text-blue-600">
                          {formatCurrency(item.stockValue)}
                        </TableCell>
                        <TableCell>
                          {item.product.isActive ? (
                            <Badge variant="default">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination Controls */}
              {inventoryItems.length > 0 && (
                <div className="flex items-center justify-between mt-4 pt-4 border-t">
                  <div className="text-sm text-gray-600">
                    Showing {startIndex + 1} to {Math.min(endIndex, inventoryItems.length)} of {inventoryItems.length} products
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

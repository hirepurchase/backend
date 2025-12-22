'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, DollarSign, FileText, Users, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

interface Contract {
  id: string;
  contractNumber: string;
  status: string;
  totalPrice: number;
  totalPaid: number;
  outstandingBalance: number;
  customer: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string;
    membershipId: string;
  };
  inventoryItem: {
    product: {
      name: string;
    };
  };
  installments: Array<{
    id: string;
    status: string;
    amount: number;
    paidAmount: number;
  }>;
}

export default function PaymentsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [filteredContracts, setFilteredContracts] = useState<Contract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(10);
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    loadContracts();
  }, []);

  useEffect(() => {
    if (searchQuery) {
      const filtered = contracts.filter(
        (c) =>
          c.contractNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.customer.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.customer.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.customer.phone.includes(searchQuery) ||
          c.customer.membershipId.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredContracts(filtered);
    } else {
      setFilteredContracts(contracts);
    }
    // Reset to first page when search changes
    setCurrentPage(1);
  }, [searchQuery, contracts]);

  const loadContracts = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/contracts');
      const allContracts = response.data.contracts || [];

      // Filter to only show active contracts with outstanding balance
      const activeContracts = allContracts.filter(
        (c: Contract) => c.status === 'ACTIVE' && c.outstandingBalance > 0
      );

      setContracts(activeContracts);
      setFilteredContracts(activeContracts);
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
    const totalContracts = contracts.length;
    const totalOutstanding = contracts.reduce((sum, c) => sum + c.outstandingBalance, 0);
    const contractsWithOverdue = contracts.filter((c) =>
      c.installments && c.installments.some((i) => i.status === 'OVERDUE')
    ).length;
    const contractsWithPartial = contracts.filter((c) =>
      c.installments && c.installments.some((i) => i.status === 'PARTIAL')
    ).length;

    return { totalContracts, totalOutstanding, contractsWithOverdue, contractsWithPartial };
  };

  const stats = getContractStats();

  // Pagination calculations
  const totalPages = Math.ceil(filteredContracts.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedContracts = filteredContracts.slice(startIndex, endIndex);

  const handlePreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(prev + 1, totalPages));
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Payment Processing</h1>
        <p className="text-gray-600 mt-1">Select a contract to process payments</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Active Contracts</p>
                <p className="text-2xl font-bold">{stats.totalContracts}</p>
              </div>
              <FileText className="h-8 w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">With Overdue</p>
                <p className="text-2xl font-bold text-red-600">{stats.contractsWithOverdue}</p>
              </div>
              <AlertCircle className="h-8 w-8 text-red-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">With Partial Payments</p>
                <p className="text-2xl font-bold text-orange-600">{stats.contractsWithPartial}</p>
              </div>
              <DollarSign className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600">Total Outstanding</p>
                <p className="text-2xl font-bold text-green-600">
                  {formatCurrency(stats.totalOutstanding)}
                </p>
              </div>
              <DollarSign className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search by contract number, customer name, phone, or membership ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* Contracts Table */}
      <Card>
        <CardHeader>
          <CardTitle>Active Contracts with Outstanding Balance ({filteredContracts.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contract Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Total Price</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedContracts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-gray-500 py-8">
                    No contracts found
                  </TableCell>
                </TableRow>
              ) : (
                paginatedContracts.map((contract) => {
                  const hasOverdue = contract.installments && contract.installments.some((i) => i.status === 'OVERDUE');
                  const hasPartial = contract.installments && contract.installments.some((i) => i.status === 'PARTIAL');

                  return (
                    <TableRow
                      key={contract.id}
                      className="cursor-pointer hover:bg-gray-50"
                      onClick={() => router.push(`/admin/payments/${contract.id}`)}
                    >
                      <TableCell className="font-medium">{contract.contractNumber}</TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            {contract.customer.firstName} {contract.customer.lastName}
                          </p>
                          <p className="text-sm text-gray-600">{contract.customer.phone}</p>
                          <p className="text-xs text-gray-500">ID: {contract.customer.membershipId}</p>
                        </div>
                      </TableCell>
                      <TableCell>{contract.inventoryItem.product.name}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(contract.totalPrice)}
                      </TableCell>
                      <TableCell className="text-right text-green-600 font-semibold">
                        {formatCurrency(contract.totalPaid)}
                      </TableCell>
                      <TableCell className="text-right text-red-600 font-semibold">
                        {formatCurrency(contract.outstandingBalance)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge className={getStatusColor(contract.status)}>
                            {contract.status}
                          </Badge>
                          {hasOverdue && (
                            <Badge className="bg-red-100 text-red-800 text-xs">
                              Has Overdue
                            </Badge>
                          )}
                          {hasPartial && (
                            <Badge className="bg-orange-100 text-orange-800 text-xs">
                              Has Partial
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          {/* Pagination Controls */}
          {filteredContracts.length > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <div className="text-sm text-gray-600">
                Showing {startIndex + 1} to {Math.min(endIndex, filteredContracts.length)} of {filteredContracts.length} contracts
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
        </CardContent>
      </Card>
    </div>
  );
}

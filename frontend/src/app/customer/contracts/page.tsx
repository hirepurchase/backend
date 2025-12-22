'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { formatCurrency, formatDate, getStatusColor, calculateProgress } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function CustomerContractsPage() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [filteredContracts, setFilteredContracts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
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
          c.inventoryItem?.product?.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
      setFilteredContracts(filtered);
    } else {
      setFilteredContracts(contracts);
    }
  }, [searchQuery, contracts]);

  const loadContracts = async () => {
    try {
      setIsLoading(true);
      const response = await api.get('/customers/me/contracts');
      const contractsData = response.data.contracts || [];
      setContracts(contractsData);
      setFilteredContracts(contractsData);
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
        <h1 className="text-3xl font-bold text-gray-900">My Contracts</h1>
        <p className="text-gray-600 mt-1">View all your hire purchase contracts</p>
      </div>

      {/* Search */}
      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              placeholder="Search by contract number or product name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {/* Contracts Grid */}
      {filteredContracts.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No contracts found</p>
              <p className="text-sm mt-1">
                {searchQuery ? 'Try a different search term' : 'You don\'t have any contracts yet'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {filteredContracts.map((contract) => {
            const progress = calculateProgress(contract.totalPaid, contract.totalPrice);
            return (
              <Card
                key={contract.id}
                className="cursor-pointer hover:shadow-lg transition-shadow"
                onClick={() => router.push(`/customer/contracts/${contract.id}`)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg">{contract.contractNumber}</CardTitle>
                      <p className="text-sm text-gray-600 mt-1">
                        {contract.inventoryItem?.product?.name}
                      </p>
                    </div>
                    <Badge className={getStatusColor(contract.status)}>
                      {contract.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {/* Financial Summary */}
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <p className="text-gray-600">Total Price</p>
                        <p className="font-semibold">{formatCurrency(contract.totalPrice)}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Total Paid</p>
                        <p className="font-semibold text-green-600">
                          {formatCurrency(contract.totalPaid)}
                        </p>
                      </div>
                      <div>
                        <p className="text-gray-600">Outstanding</p>
                        <p className="font-semibold text-red-600">
                          {formatCurrency(contract.outstandingBalance)}
                        </p>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div>
                      <div className="flex items-center justify-between text-sm mb-2">
                        <span className="text-gray-600">Progress</span>
                        <span className="font-semibold">{progress.toFixed(0)}%</span>
                      </div>
                      <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-500 transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>

                    {/* Payment Terms */}
                    <div className="grid grid-cols-2 gap-4 text-sm pt-2 border-t">
                      <div>
                        <p className="text-gray-600">Payment Frequency</p>
                        <p className="font-medium">{contract.paymentFrequency}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Installment Amount</p>
                        <p className="font-medium">{formatCurrency(contract.installmentAmount)}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">Start Date</p>
                        <p className="font-medium">{formatDate(contract.startDate)}</p>
                      </div>
                      <div>
                        <p className="text-gray-600">End Date</p>
                        <p className="font-medium">{formatDate(contract.endDate)}</p>
                      </div>
                    </div>

                    {/* Product Details */}
                    <div className="pt-2 border-t text-sm">
                      <p className="text-gray-600">Serial/IMEI</p>
                      <p className="font-mono text-xs">
                        {contract.inventoryItem?.serialNumber}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

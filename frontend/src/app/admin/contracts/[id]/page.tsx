'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Edit, FileText, User, Package, Calendar, DollarSign, CalendarRange, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import api from '@/lib/api';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

export default function ContractDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const [contract, setContract] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [newStartDate, setNewStartDate] = useState('');
  const [showEditInstallmentDialog, setShowEditInstallmentDialog] = useState(false);
  const [editingInstallment, setEditingInstallment] = useState<any>(null);
  const [isEditingInstallment, setIsEditingInstallment] = useState(false);
  const [installmentEditData, setInstallmentEditData] = useState({
    amount: '',
    dueDate: '',
  });
  const [editFormData, setEditFormData] = useState({
    gracePeriodDays: '',
    penaltyPercentage: '',
    paymentMethod: '',
    mobileMoneyNetwork: '',
    mobileMoneyNumber: '',
  });

  useEffect(() => {
    loadContract();
  }, [params.id]);

  const loadContract = async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/contracts/admin/${params.id}`);
      setContract(response.data);
      setEditFormData({
        gracePeriodDays: response.data.gracePeriodDays?.toString() || '0',
        penaltyPercentage: response.data.penaltyPercentage?.toString() || '0',
        paymentMethod: response.data.paymentMethod || '',
        mobileMoneyNetwork: response.data.mobileMoneyNetwork || '',
        mobileMoneyNumber: response.data.mobileMoneyNumber || '',
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to load contract details',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAmendContract = async () => {
    try {
      const updateData: any = {
        gracePeriodDays: Number(editFormData.gracePeriodDays),
        penaltyPercentage: Number(editFormData.penaltyPercentage),
      };

      if (editFormData.paymentMethod) {
        updateData.paymentMethod = editFormData.paymentMethod;

        if (editFormData.paymentMethod === 'HUBTEL_MOMO' || editFormData.paymentMethod === 'HUBTEL_DIRECT_DEBIT') {
          if (!editFormData.mobileMoneyNetwork || !editFormData.mobileMoneyNumber) {
            toast({
              title: 'Error',
              description: 'Mobile money network and number are required for Hubtel payment method',
              variant: 'destructive',
            });
            return;
          }
          updateData.mobileMoneyNetwork = editFormData.mobileMoneyNetwork;
          updateData.mobileMoneyNumber = editFormData.mobileMoneyNumber;
        }
      }

      await api.put(`/contracts/${params.id}`, updateData);

      toast({
        title: 'Success',
        description: 'Contract has been updated successfully',
      });

      setIsEditing(false);
      loadContract();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to update contract',
        variant: 'destructive',
      });
    }
  };

  const handleRescheduleInstallments = async () => {
    if (!newStartDate) {
      toast({
        title: 'Error',
        description: 'Please select a new start date',
        variant: 'destructive',
      });
      return;
    }

    setIsRescheduling(true);

    try {
      await api.post(`/contracts/${params.id}/reschedule`, {
        newStartDate,
      });

      toast({
        title: 'Success',
        description: 'Installments have been rescheduled successfully',
      });

      setShowRescheduleDialog(false);
      setNewStartDate('');
      loadContract();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to reschedule installments',
        variant: 'destructive',
      });
    } finally {
      setIsRescheduling(false);
    }
  };

  const hasPaidInstallments = contract?.installments?.some(
    (i: any) => i.status === 'PAID' || i.paidAmount > 0
  );

  const openEditInstallmentDialog = (installment: any) => {
    setEditingInstallment(installment);
    setInstallmentEditData({
      amount: installment.amount.toString(),
      dueDate: new Date(installment.dueDate).toISOString().split('T')[0],
    });
    setShowEditInstallmentDialog(true);
  };

  const handleEditInstallment = async () => {
    if (!editingInstallment) return;

    if (!installmentEditData.amount && !installmentEditData.dueDate) {
      toast({
        title: 'Error',
        description: 'Please update at least one field',
        variant: 'destructive',
      });
      return;
    }

    setIsEditingInstallment(true);

    try {
      const updateData: any = {};
      if (installmentEditData.amount && installmentEditData.amount !== editingInstallment.amount.toString()) {
        updateData.amount = Number(installmentEditData.amount);
      }
      if (installmentEditData.dueDate && installmentEditData.dueDate !== new Date(editingInstallment.dueDate).toISOString().split('T')[0]) {
        updateData.dueDate = installmentEditData.dueDate;
      }

      if (Object.keys(updateData).length === 0) {
        toast({
          title: 'Info',
          description: 'No changes detected',
        });
        setShowEditInstallmentDialog(false);
        return;
      }

      await api.put(`/contracts/${params.id}/installments/${editingInstallment.id}`, updateData);

      toast({
        title: 'Success',
        description: 'Installment has been updated successfully. Remaining installments have been auto-recalculated.',
      });

      setShowEditInstallmentDialog(false);
      setEditingInstallment(null);
      loadContract();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.response?.data?.error || 'Failed to update installment',
        variant: 'destructive',
      });
    } finally {
      setIsEditingInstallment(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="p-8">
        <div className="text-center">
          <FileText className="h-16 w-16 mx-auto mb-4 text-gray-400" />
          <p className="text-lg text-gray-600">Contract not found</p>
          <Button className="mt-4" onClick={() => router.push('/admin/contracts')}>
            Back to Contracts
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <Button variant="outline" onClick={() => router.push('/admin/contracts')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Contracts
        </Button>

        {!isEditing && contract.status === 'ACTIVE' && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setShowRescheduleDialog(true)}
              disabled={hasPaidInstallments}
              title={hasPaidInstallments ? 'Cannot reschedule after payments have been made' : ''}
            >
              <CalendarRange className="mr-2 h-4 w-4" />
              Reschedule Installments
            </Button>
            <Button onClick={() => setIsEditing(true)}>
              <Edit className="mr-2 h-4 w-4" />
              Amend Contract
            </Button>
          </div>
        )}
      </div>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl">Contract {contract.contractNumber}</CardTitle>
              <p className="text-sm text-gray-500 mt-1">
                Created on {formatDate(contract.createdAt)}
              </p>
            </div>
            <Badge className={getStatusColor(contract.status)} style={{ fontSize: '16px', padding: '8px 16px' }}>
              {contract.status}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Customer Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {contract.customer?.photoUrl && (
              <div className="flex justify-center mb-4">
                <img
                  src={contract.customer.photoUrl}
                  alt={`${contract.customer.firstName} ${contract.customer.lastName}`}
                  className="w-24 h-24 rounded-lg object-cover border-2 border-gray-200"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </div>
            )}
            <div>
              <p className="text-sm text-gray-500">Name</p>
              <p className="font-medium">
                {contract.customer?.firstName} {contract.customer?.lastName}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Membership ID</p>
              <p className="font-mono">{contract.customer?.membershipId}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Phone</p>
              <p>{contract.customer?.phone}</p>
            </div>
            {contract.customer?.email && (
              <div>
                <p className="text-sm text-gray-500">Email</p>
                <p>{contract.customer.email}</p>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-4"
              onClick={() => router.push(`/admin/customers/${contract.customer?.id}`)}
            >
              View Customer Details
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Product Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm text-gray-500">Product</p>
              <p className="font-medium">{contract.inventoryItem?.product?.name || '-'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Category</p>
              <p>{contract.inventoryItem?.product?.category?.name || '-'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Serial/IMEI Number</p>
              <p className="font-mono">{contract.inventoryItem?.serialNumber || '-'}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Base Price</p>
              <p className="font-semibold">{formatCurrency(contract.inventoryItem?.product?.basePrice || 0)}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Contract Terms
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm text-gray-500">Total Price</p>
              <p className="font-semibold text-lg">{formatCurrency(contract.totalPrice)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Deposit Amount</p>
              <p className="font-semibold">{formatCurrency(contract.depositAmount)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Finance Amount</p>
              <p className="font-semibold">{formatCurrency(contract.financeAmount)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Payment Frequency</p>
              <p>{contract.paymentFrequency}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Installment Amount</p>
              <p className="font-semibold">{formatCurrency(contract.installmentAmount)}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Installments</p>
              <p>{contract.totalInstallments}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Start Date → End Date</p>
              <p>{formatDate(contract.startDate)} → {formatDate(contract.endDate)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            Payment Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-4 bg-green-50 rounded-lg border border-green-200">
              <p className="text-sm text-green-700 font-medium">Total Paid</p>
              <p className="text-2xl font-bold text-green-700 mt-1">
                {formatCurrency(contract.totalPaid)}
              </p>
            </div>
            <div className="p-4 bg-red-50 rounded-lg border border-red-200">
              <p className="text-sm text-red-700 font-medium">Outstanding Balance</p>
              <p className="text-2xl font-bold text-red-700 mt-1">
                {formatCurrency(contract.outstandingBalance)}
              </p>
            </div>
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-sm text-blue-700 font-medium">Progress</p>
              <p className="text-2xl font-bold text-blue-700 mt-1">
                {((contract.totalPaid / contract.totalPrice) * 100).toFixed(1)}%
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {isEditing && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Amend Contract Terms</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <Label>Grace Period (Days)</Label>
                <Input
                  type="number"
                  value={editFormData.gracePeriodDays}
                  onChange={(e) => setEditFormData({ ...editFormData, gracePeriodDays: e.target.value })}
                  placeholder="e.g., 7"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Number of days grace period before penalties apply
                </p>
              </div>
              <div>
                <Label>Penalty Percentage (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={editFormData.penaltyPercentage}
                  onChange={(e) => setEditFormData({ ...editFormData, penaltyPercentage: e.target.value })}
                  placeholder="e.g., 2.5"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Percentage penalty for late payments
                </p>
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-lg font-semibold mb-4">Payment Method</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                  <Label>Payment Method</Label>
                  <Select
                    value={editFormData.paymentMethod}
                    onValueChange={(value) => setEditFormData({ ...editFormData, paymentMethod: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select payment method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">No preference</SelectItem>
                      <SelectItem value="HUBTEL_MOMO">Hubtel Mobile Money</SelectItem>
                      <SelectItem value="HUBTEL_DIRECT_DEBIT">Hubtel Direct Debit</SelectItem>
                      <SelectItem value="CASH">Cash</SelectItem>
                      <SelectItem value="BANK_TRANSFER">Bank Transfer</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500 mt-1">
                    Preferred payment collection method
                  </p>
                </div>

                {(editFormData.paymentMethod === 'HUBTEL_MOMO' || editFormData.paymentMethod === 'HUBTEL_DIRECT_DEBIT') && (
                  <>
                    <div>
                      <Label>Mobile Money Network</Label>
                      <Select
                        value={editFormData.mobileMoneyNetwork}
                        onValueChange={(value) => setEditFormData({ ...editFormData, mobileMoneyNetwork: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select network" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="MTN">MTN</SelectItem>
                          <SelectItem value="VODAFONE">Vodafone</SelectItem>
                          <SelectItem value="TELECEL">Telecel</SelectItem>
                          <SelectItem value="AIRTELTIGO">AirtelTigo</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-gray-500 mt-1">
                        Customer mobile money provider
                      </p>
                    </div>

                    <div>
                      <Label>Mobile Money Number</Label>
                      <Input
                        type="text"
                        value={editFormData.mobileMoneyNumber}
                        onChange={(e) => setEditFormData({ ...editFormData, mobileMoneyNumber: e.target.value })}
                        placeholder="e.g., 0244123456"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Customer mobile money number
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-4 mt-6">
              <Button onClick={handleAmendContract}>
                Save Changes
              </Button>
              <Button variant="outline" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {contract.installments && contract.installments.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Installment Schedule
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Installment #</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paid On</TableHead>
                  {contract.status === 'ACTIVE' && <TableHead>Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {contract.installments.map((installment: any) => {
                  const isPaid = installment.status === 'PAID' || installment.paidAmount > 0;
                  return (
                    <TableRow key={installment.id}>
                      <TableCell className="font-medium">
                        #{installment.installmentNo}
                      </TableCell>
                      <TableCell>{formatDate(installment.dueDate)}</TableCell>
                      <TableCell className="font-semibold">
                        {formatCurrency(installment.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge className={getStatusColor(installment.status)}>
                          {installment.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {installment.paidAt ? formatDate(installment.paidAt) : '-'}
                      </TableCell>
                      {contract.status === 'ACTIVE' && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditInstallmentDialog(installment)}
                            disabled={isPaid}
                            title={isPaid ? 'Cannot edit paid installments' : 'Edit installment'}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {contract.signatureUrl && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Customer Signature</CardTitle>
          </CardHeader>
          <CardContent>
            <img
              src={contract.signatureUrl}
              alt="Customer signature"
              className="max-w-md border-2 border-gray-200 rounded-lg"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
                const parent = e.currentTarget.parentElement;
                if (parent) {
                  parent.innerHTML = '<p class="text-gray-500">Signature image unavailable</p>';
                }
              }}
            />
          </CardContent>
        </Card>
      )}

      {/* Reschedule Dialog */}
      <Dialog open={showRescheduleDialog} onOpenChange={setShowRescheduleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule Installments</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <p className="text-sm text-yellow-800">
                <strong>Warning:</strong> This will reschedule all installments to new dates starting from the selected date.
                This action can only be performed if no payments have been made yet.
              </p>
            </div>

            <div>
              <Label htmlFor="newStartDate">New Start Date</Label>
              <Input
                id="newStartDate"
                type="date"
                value={newStartDate}
                onChange={(e) => setNewStartDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
              />
              <p className="text-xs text-gray-500 mt-1">
                All installments will be recalculated from this date
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                <strong>Current Schedule:</strong>
              </p>
              <ul className="text-sm text-blue-800 mt-2 space-y-1">
                <li>Start Date: {formatDate(contract.startDate)}</li>
                <li>End Date: {formatDate(contract.endDate)}</li>
                <li>Total Installments: {contract.totalInstallments}</li>
                <li>Payment Frequency: {contract.paymentFrequency}</li>
              </ul>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                onClick={handleRescheduleInstallments}
                disabled={isRescheduling || !newStartDate}
              >
                {isRescheduling ? 'Rescheduling...' : 'Confirm Reschedule'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowRescheduleDialog(false);
                  setNewStartDate('');
                }}
                disabled={isRescheduling}
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Installment Dialog */}
      <Dialog open={showEditInstallmentDialog} onOpenChange={setShowEditInstallmentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Installment #{editingInstallment?.installmentNo}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800">
                <strong>Auto-Recalculation:</strong> When you change the amount, all remaining unpaid installments will be automatically adjusted to maintain the total contract value.
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
              <p className="text-sm text-gray-700">
                <strong>Current Values:</strong>
              </p>
              <ul className="text-sm text-gray-700 mt-2 space-y-1">
                <li>Amount: {formatCurrency(editingInstallment?.amount || 0)}</li>
                <li>Due Date: {editingInstallment?.dueDate ? formatDate(editingInstallment.dueDate) : '-'}</li>
              </ul>
            </div>

            <div>
              <Label htmlFor="installmentAmount">Installment Amount (GHS)</Label>
              <Input
                id="installmentAmount"
                type="number"
                step="0.01"
                value={installmentEditData.amount}
                onChange={(e) => setInstallmentEditData({ ...installmentEditData, amount: e.target.value })}
                placeholder="Enter new amount"
              />
              <p className="text-xs text-gray-500 mt-1">
                Changing this will auto-adjust remaining installments
              </p>
            </div>

            <div>
              <Label htmlFor="installmentDueDate">Due Date</Label>
              <Input
                id="installmentDueDate"
                type="date"
                value={installmentEditData.dueDate}
                onChange={(e) => setInstallmentEditData({ ...installmentEditData, dueDate: e.target.value })}
                min={new Date().toISOString().split('T')[0]}
              />
              <p className="text-xs text-gray-500 mt-1">
                Update the due date for this installment
              </p>
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                onClick={handleEditInstallment}
                disabled={isEditingInstallment}
              >
                {isEditingInstallment ? 'Updating...' : 'Update Installment'}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowEditInstallmentDialog(false);
                  setEditingInstallment(null);
                }}
                disabled={isEditingInstallment}
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

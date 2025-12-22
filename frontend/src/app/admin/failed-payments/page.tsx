"use client";

import { useState, useEffect } from "react";
import api from "@/lib/api";
import { useToast } from "@/hooks/useToast";

interface FailedPayment {
  id: string;
  transactionRef: string;
  amount: number;
  status: string;
  failureReason: string | null;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  lastRetryAt: string | null;
  isAutoRetryEnabled: boolean;
  createdAt: string;
  contract: {
    id: string;
    contractNumber: string;
    customer: {
      id: string;
      firstName: string;
      lastName: string;
      phone: string;
      email: string | null;
    };
    inventoryItem: {
      product: {
        name: string;
      };
    } | null;
  };
  retries: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    failureReason: string | null;
    attemptedAt: string;
  }>;
}

export default function FailedPaymentsPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"failed-payments" | "retry-settings">("failed-payments");
  const [payments, setPayments] = useState<FailedPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPayments, setSelectedPayments] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(20);

  useEffect(() => {
    fetchFailedPayments();
  }, [page]);

  const fetchFailedPayments = async () => {
    try {
      setLoading(true);
      const response = await api.get("/payment-retry/failed", {
        params: {
          limit,
          offset: page * limit,
        },
      });
      setPayments(response.data.payments);
      setTotal(response.data.total);
    } catch (error: any) {
      console.error("Error fetching failed payments:", error);
      toast({ title: "Error", description: "Failed to load failed payments", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPayment = (paymentId: string) => {
    const newSelected = new Set(selectedPayments);
    if (newSelected.has(paymentId)) {
      newSelected.delete(paymentId);
    } else {
      newSelected.add(paymentId);
    }
    setSelectedPayments(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedPayments.size === payments.length) {
      setSelectedPayments(new Set());
    } else {
      setSelectedPayments(new Set(payments.map((p) => p.id)));
    }
  };

  const handleRetrySingle = async (paymentId: string) => {
    try {
      setRetrying(true);
      await api.post(`/payment-retry/retry/${paymentId}`);
      toast({ title: "Success", description: "Payment retry initiated successfully" });
      await fetchFailedPayments();
    } catch (error: any) {
      console.error("Error retrying payment:", error);
      toast({ title: "Error", description: error.response?.data?.message || "Failed to retry payment", variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  };

  const handleRetrySelected = async () => {
    if (selectedPayments.size === 0) {
      toast({ title: "Error", description: "Please select at least one payment to retry", variant: "destructive" });
      return;
    }

    try {
      setRetrying(true);
      const response = await api.post("/payment-retry/retry-multiple", {
        paymentIds: Array.from(selectedPayments),
      });
      toast({
        title: "Success",
        description: `Retried ${response.data.succeeded} payments. ${response.data.failed} failed.`
      });
      setSelectedPayments(new Set());
      await fetchFailedPayments();
    } catch (error: any) {
      console.error("Error retrying payments:", error);
      toast({ title: "Error", description: "Failed to retry selected payments", variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  };

  const handleRetryAll = async () => {
    if (!confirm("Are you sure you want to retry all failed payments?")) {
      return;
    }

    try {
      setRetrying(true);
      const response = await api.post("/payment-retry/retry-all");
      toast({
        title: "Success",
        description: `Processed ${response.data.processed} payments. ${response.data.succeeded} succeeded, ${response.data.failed} failed.`
      });
      await fetchFailedPayments();
    } catch (error: any) {
      console.error("Error retrying all payments:", error);
      toast({ title: "Error", description: "Failed to retry all payments", variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  };

  const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`;
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const totalPages = Math.ceil(total / limit);

  if (loading && payments.length === 0) {
    return (
      <div className="p-8">
        <div className="flex justify-center items-center h-64">
          <div className="text-lg text-gray-600">Loading failed payments...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Payment Management</h1>
        <p className="text-gray-600 mt-2">
          Manage failed payments and configure retry settings
        </p>
      </div>

      {/* Tabs */}
      <div className="mb-6 border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab("failed-payments")}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${
                activeTab === "failed-payments"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }
            `}
          >
            Failed Payments
          </button>
          <button
            onClick={() => setActiveTab("retry-settings")}
            className={`
              py-4 px-1 border-b-2 font-medium text-sm
              ${
                activeTab === "retry-settings"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }
            `}
          >
            Retry Settings
          </button>
        </nav>
      </div>

      {/* Failed Payments Tab Content */}
      {activeTab === "failed-payments" && (
        <div className="bg-white rounded-lg shadow-sm border p-6">
        {/* Actions Bar */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-4">
            <button
              onClick={handleSelectAll}
              className="text-sm px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              {selectedPayments.size === payments.length ? "Deselect All" : "Select All"}
            </button>
            {selectedPayments.size > 0 && (
              <span className="text-sm text-gray-600">
                {selectedPayments.size} selected
              </span>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleRetrySelected}
              disabled={selectedPayments.size === 0 || retrying}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {retrying ? "Retrying..." : `Retry Selected (${selectedPayments.size})`}
            </button>
            <button
              onClick={handleRetryAll}
              disabled={retrying || payments.length === 0}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              Retry All Eligible
            </button>
          </div>
        </div>

        {/* Payments Table */}
        {payments.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No failed payments found
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="w-12 px-3 py-3 text-left">
                    <input
                      type="checkbox"
                      checked={selectedPayments.size === payments.length}
                      onChange={handleSelectAll}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Transaction
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Contract
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Failure Reason
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Retries
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Next Retry
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-gray-50">
                    <td className="px-3 py-4">
                      <input
                        type="checkbox"
                        checked={selectedPayments.has(payment.id)}
                        onChange={() => handleSelectPayment(payment.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm">
                        <div className="font-medium text-gray-900">
                          {payment.transactionRef}
                        </div>
                        <div className="text-gray-500 text-xs">
                          {formatDate(payment.createdAt)}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm">
                        <div className="font-medium text-gray-900">
                          {payment.contract.customer.firstName}{" "}
                          {payment.contract.customer.lastName}
                        </div>
                        <div className="text-gray-500 text-xs">
                          {payment.contract.customer.phone}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm">
                        <div className="font-medium text-gray-900">
                          {payment.contract.contractNumber}
                        </div>
                        {payment.contract.inventoryItem && (
                          <div className="text-gray-500 text-xs">
                            {payment.contract.inventoryItem.product.name}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-900">
                      {formatCurrency(payment.amount)}
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-red-600">
                        {payment.failureReason || "Unknown"}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm">
                        <div className="font-medium text-gray-900">
                          {payment.retryCount} / {payment.maxRetries}
                        </div>
                        {payment.retries.length > 0 && (
                          <div className="text-xs text-gray-500">
                            Last: {formatDate(payment.retries[0].attemptedAt)}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {payment.nextRetryAt ? (
                        <div className="text-sm">
                          <div className="text-gray-900">
                            {formatDate(payment.nextRetryAt)}
                          </div>
                          {payment.isAutoRetryEnabled && (
                            <div className="text-xs text-green-600">Auto</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">No more retries</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleRetrySingle(payment.id)}
                        disabled={retrying || payment.retryCount >= payment.maxRetries}
                        className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                      >
                        Retry Now
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-between items-center mt-6 pt-4 border-t">
            <div className="text-sm text-gray-600">
              Showing {page * limit + 1} to {Math.min((page + 1) * limit, total)} of{" "}
              {total} failed payments
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 0}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages - 1}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        )}
        </div>
      )}

      {/* Retry Settings Tab Content */}
      {activeTab === "retry-settings" && (
        <RetrySettingsTab />
      )}
    </div>
  );
}

// Retry Settings Component
function RetrySettingsTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState({
    enableAutoRetry: true,
    maxRetryAttempts: 3,
    retryIntervalHours: 24,
    retrySchedule: "1,3,7",
    notifyOnFailure: true,
    notifyCustomerOnFailure: true,
    sendSMSOnFailure: true,
    failureSMSTemplate: "",
  });

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const response = await api.get("/payment-retry/settings");
      setSettings(response.data);
      setFormData({
        enableAutoRetry: response.data.enableAutoRetry,
        maxRetryAttempts: response.data.maxRetryAttempts,
        retryIntervalHours: response.data.retryIntervalHours,
        retrySchedule: response.data.retrySchedule,
        notifyOnFailure: response.data.notifyOnFailure,
        notifyCustomerOnFailure: response.data.notifyCustomerOnFailure,
        sendSMSOnFailure: response.data.sendSMSOnFailure,
        failureSMSTemplate: response.data.failureSMSTemplate || "",
      });
    } catch (error: any) {
      console.error("Error fetching retry settings:", error);
      toast({ title: "Error", description: "Failed to load retry settings", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);

      // Validation
      if (formData.maxRetryAttempts < 0 || formData.maxRetryAttempts > 10) {
        toast({ title: "Error", description: "Max retry attempts must be between 0 and 10", variant: "destructive" });
        return;
      }

      if (formData.retryIntervalHours < 1 || formData.retryIntervalHours > 168) {
        toast({ title: "Error", description: "Retry interval must be between 1 and 168 hours", variant: "destructive" });
        return;
      }

      // Validate retry schedule format
      const scheduleArray = formData.retrySchedule.split(",").map((d) => parseInt(d.trim()));
      if (scheduleArray.some((d) => isNaN(d) || d < 0 || d > 30)) {
        toast({ title: "Error", description: "Retry schedule must be comma-separated numbers between 0 and 30", variant: "destructive" });
        return;
      }

      await api.put("/payment-retry/settings", formData);
      toast({ title: "Success", description: "Retry settings saved successfully" });
      await fetchSettings();
    } catch (error: any) {
      console.error("Error saving retry settings:", error);
      toast({ title: "Error", description: error.response?.data?.error || "Failed to save retry settings", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex justify-center items-center h-64">
          <div className="text-lg text-gray-600">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6 max-w-4xl">
      <div className="space-y-6">
        {/* Auto Retry Toggle */}
        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
          <div>
            <h3 className="font-medium text-gray-900">Enable Automatic Retry</h3>
            <p className="text-sm text-gray-600">Automatically retry failed payments</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={formData.enableAutoRetry}
              onChange={(e) => setFormData({ ...formData, enableAutoRetry: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Max Retry Attempts */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Maximum Retry Attempts
            </label>
            <input
              type="number"
              min="0"
              max="10"
              value={formData.maxRetryAttempts}
              onChange={(e) => setFormData({ ...formData, maxRetryAttempts: parseInt(e.target.value) })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">Number of times to retry a failed payment (0-10)</p>
          </div>

          {/* Retry Interval */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Retry Interval (Hours)
            </label>
            <input
              type="number"
              min="1"
              max="168"
              value={formData.retryIntervalHours}
              onChange={(e) => setFormData({ ...formData, retryIntervalHours: parseInt(e.target.value) })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">Hours between retry attempts (1-168)</p>
          </div>
        </div>

        {/* Retry Schedule */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Retry Schedule (Days)
          </label>
          <input
            type="text"
            value={formData.retrySchedule}
            onChange={(e) => setFormData({ ...formData, retrySchedule: e.target.value })}
            placeholder="e.g., 1,3,7"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Comma-separated days to retry (e.g., "1,3,7" means retry on day 1, 3, and 7)
          </p>
        </div>

        {/* Notification Settings */}
        <div className="border-t pt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Notification Settings</h3>
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="notifyOnFailure"
                checked={formData.notifyOnFailure}
                onChange={(e) => setFormData({ ...formData, notifyOnFailure: e.target.checked })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="notifyOnFailure" className="ml-3 text-sm text-gray-700">
                Notify admin on payment failure
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="notifyCustomerOnFailure"
                checked={formData.notifyCustomerOnFailure}
                onChange={(e) => setFormData({ ...formData, notifyCustomerOnFailure: e.target.checked })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="notifyCustomerOnFailure" className="ml-3 text-sm text-gray-700">
                Notify customer on payment failure
              </label>
            </div>

            <div className="flex items-center">
              <input
                type="checkbox"
                id="sendSMSOnFailure"
                checked={formData.sendSMSOnFailure}
                onChange={(e) => setFormData({ ...formData, sendSMSOnFailure: e.target.checked })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="sendSMSOnFailure" className="ml-3 text-sm text-gray-700">
                Send SMS on payment failure
              </label>
            </div>
          </div>
        </div>

        {/* SMS Template */}
        {formData.sendSMSOnFailure && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Failure SMS Template
            </label>
            <textarea
              value={formData.failureSMSTemplate}
              onChange={(e) => setFormData({ ...formData, failureSMSTemplate: e.target.value })}
              placeholder="Enter SMS template for payment failure notifications..."
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Available variables: {"{"}customerName{"}"}, {"{"}amount{"}"}, {"{"}contractNumber{"}"}
            </p>
          </div>
        )}

        {/* Save Button */}
        <div className="flex justify-end pt-6 border-t">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

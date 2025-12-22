"use client";

import { useState, useEffect } from "react";
import api from "@/lib/api";
import { useToast } from "@/hooks/useToast";

interface RetrySettings {
  id: string;
  enableAutoRetry: boolean;
  maxRetryAttempts: number;
  retryIntervalHours: number;
  retrySchedule: string;
  notifyOnFailure: boolean;
  notifyCustomerOnFailure: boolean;
  sendSMSOnFailure: boolean;
  failureSMSTemplate: string | null;
}

export default function RetrySettingsPage() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<RetrySettings | null>(null);
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
      <div className="p-8">
        <div className="flex justify-center items-center h-64">
          <div className="text-lg text-gray-600">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-800">Payment Retry Settings</h1>
        <p className="text-gray-600 mt-2">
          Configure automatic retry settings for failed payments
        </p>
      </div>

      <div className="max-w-3xl bg-white rounded-lg shadow-sm border p-6">
        {/* Auto Retry Toggle */}
        <div className="mb-6 pb-6 border-b">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-800">Enable Auto Retry</h3>
              <p className="text-sm text-gray-600 mt-1">
                Automatically retry failed payments based on the schedule below
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={formData.enableAutoRetry}
                onChange={(e) =>
                  setFormData({ ...formData, enableAutoRetry: e.target.checked })
                }
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        {/* Retry Configuration */}
        <div className="space-y-6 mb-6 pb-6 border-b">
          <h3 className="text-lg font-semibold text-gray-800">Retry Configuration</h3>

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
              onChange={(e) =>
                setFormData({ ...formData, maxRetryAttempts: parseInt(e.target.value) })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Maximum number of retry attempts (0-10)
            </p>
          </div>

          {/* Retry Interval Hours */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Retry Interval (Hours)
            </label>
            <input
              type="number"
              min="1"
              max="168"
              value={formData.retryIntervalHours}
              onChange={(e) =>
                setFormData({ ...formData, retryIntervalHours: parseInt(e.target.value) })
              }
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Hours to wait between retry attempts (1-168)
            </p>
          </div>

          {/* Retry Schedule */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Retry Schedule (Days)
            </label>
            <input
              type="text"
              value={formData.retrySchedule}
              onChange={(e) =>
                setFormData({ ...formData, retrySchedule: e.target.value })
              }
              placeholder="1,3,7"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Comma-separated days for retry attempts (e.g., 1,3,7 means retry on day 1, 3,
              and 7)
            </p>
            <div className="mt-2 p-3 bg-blue-50 rounded-lg">
              <p className="text-xs text-blue-800">
                <strong>Example:</strong> Schedule "1,3,7" with 3 max retries means:
                <br />• Attempt 1: 1 day after failure
                <br />• Attempt 2: 3 days after failure
                <br />• Attempt 3: 7 days after failure
              </p>
            </div>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="space-y-4 mb-6 pb-6 border-b">
          <h3 className="text-lg font-semibold text-gray-800">Notification Settings</h3>

          {/* Notify on Failure */}
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-gray-700">Notify Admin on Failure</h4>
              <p className="text-xs text-gray-500">
                Send notification to admins when payment fails
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={formData.notifyOnFailure}
                onChange={(e) =>
                  setFormData({ ...formData, notifyOnFailure: e.target.checked })
                }
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* Notify Customer on Failure */}
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-gray-700">
                Notify Customer on Failure
              </h4>
              <p className="text-xs text-gray-500">
                Send notification to customer when their payment fails
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={formData.notifyCustomerOnFailure}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    notifyCustomerOnFailure: e.target.checked,
                  })
                }
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {/* Send SMS on Failure */}
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-medium text-gray-700">Send SMS on Failure</h4>
              <p className="text-xs text-gray-500">
                Send SMS to customer when payment fails (requires customer notification enabled)
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={formData.sendSMSOnFailure}
                onChange={(e) =>
                  setFormData({ ...formData, sendSMSOnFailure: e.target.checked })
                }
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>

        {/* SMS Template */}
        {formData.sendSMSOnFailure && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Failure SMS Template (Optional)
            </label>
            <textarea
              value={formData.failureSMSTemplate}
              onChange={(e) =>
                setFormData({ ...formData, failureSMSTemplate: e.target.value })
              }
              rows={4}
              placeholder="Leave empty to use default template"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="text-xs text-gray-500 mt-1">
              Available placeholders: {"{customerName}"}, {"{amount}"}, {"{contractNumber}"}
            </p>
          </div>
        )}

        {/* Save Button */}
        <div className="flex justify-end gap-3">
          <button
            onClick={fetchSettings}
            disabled={saving}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Reset
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

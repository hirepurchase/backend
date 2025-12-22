"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/useToast";
import {
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  RefreshCw,
  CreditCard,
  Users,
  FileText,
  Shield,
  AlertCircle,
} from "lucide-react";

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

interface Contract {
  id: string;
  contractNumber: string;
  customer: Customer;
  outstandingBalance: number;
}

interface Preapproval {
  id: string;
  clientReferenceId: string;
  hubtelPreapprovalId: string;
  status: string;
  verificationType: string;
  customerMsisdn: string;
  channel: string;
  approvedAt: string | null;
  createdAt: string;
  customer: Customer;
}

interface Payment {
  id: string;
  transactionRef: string;
  amount: number;
  status: string;
  paymentMethod: string;
  externalRef: string | null;
  paymentDate: string | null;
  createdAt: string;
  contract: {
    contractNumber: string;
    customer: {
      firstName: string;
      lastName: string;
    };
  };
}

export default function HubtelTestPage() {
  const [activeTab, setActiveTab] = useState<"receive-money" | "preapproval" | "direct-debit" | "status">("receive-money");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // Data
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [preapprovals, setPreapprovals] = useState<Preapproval[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);

  // Receive Money Form
  const [receiveMoneyForm, setReceiveMoneyForm] = useState({
    amount: "",
    customerPhone: "",
    network: "MTN",
    customerName: "",
    description: "",
  });
  const [receiveMoneyResult, setReceiveMoneyResult] = useState<any>(null);

  // Preapproval Form
  const [preapprovalForm, setPreapprovalForm] = useState({
    customerId: "",
    customerPhone: "",
    network: "MTN",
  });
  const [preapprovalResult, setPreapprovalResult] = useState<any>(null);

  // OTP Verification Form
  const [otpForm, setOtpForm] = useState({
    clientReferenceId: "",
    otpCode: "",
    phoneNumber: "",
  });

  // Direct Debit Charge Form
  const [directDebitForm, setDirectDebitForm] = useState({
    amount: "",
    customerPhone: "",
    network: "MTN",
    customerName: "",
    description: "",
  });
  const [directDebitResult, setDirectDebitResult] = useState<any>(null);

  // Status Check Form
  const [statusForm, setStatusForm] = useState({
    transactionRef: "",
    clientReferenceId: "",
  });
  const [statusResult, setStatusResult] = useState<any>(null);

  // Load initial data
  useEffect(() => {
    loadTestData();
  }, []);

  const loadTestData = async () => {
    try {
      const [customersRes, contractsRes, preapprovalsRes, paymentsRes] = await Promise.all([
        api.get("/hubtel-test/customers"),
        api.get("/hubtel-test/contracts"),
        api.get("/hubtel-test/preapprovals"),
        api.get("/hubtel-test/payments"),
      ]);

      setCustomers(customersRes.data.customers || []);
      setContracts(contractsRes.data.contracts || []);
      setPreapprovals(preapprovalsRes.data.preapprovals || []);
      setPayments(paymentsRes.data.payments || []);
    } catch (error) {
      console.error("Load test data error:", error);
    }
  };

  // Test Receive Money
  const handleReceiveMoney = async () => {
    setLoading(true);
    setReceiveMoneyResult(null);
    try {
      const response = await api.post("/hubtel-test/receive-money", receiveMoneyForm);
      setReceiveMoneyResult(response.data);
      toast({
        title: "Success",
        description: "Receive Money initiated successfully. Check your phone for prompt.",
      });
      loadTestData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to initiate receive money",
        variant: "destructive",
      });
      setReceiveMoneyResult(error.response?.data);
    } finally {
      setLoading(false);
    }
  };

  // Test Initiate Preapproval
  const handleInitiatePreapproval = async () => {
    setLoading(true);
    setPreapprovalResult(null);
    try {
      const response = await api.post("/hubtel-test/preapproval/initiate", preapprovalForm);
      setPreapprovalResult(response.data);
      toast({
        title: "Success",
        description: response.data.message,
      });
      loadTestData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to initiate preapproval",
        variant: "destructive",
      });
      setPreapprovalResult(error.response?.data);
    } finally {
      setLoading(false);
    }
  };

  // Test Verify OTP
  const handleVerifyOTP = async () => {
    setLoading(true);
    try {
      const response = await api.post("/hubtel-test/preapproval/verify-otp", otpForm);
      toast({
        title: "Success",
        description: response.data.message || "OTP verified successfully",
      });
      loadTestData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to verify OTP",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  // Test Direct Debit Charge
  const handleDirectDebitCharge = async () => {
    setLoading(true);
    setDirectDebitResult(null);
    try {
      const response = await api.post("/hubtel-test/direct-debit/charge", directDebitForm);
      setDirectDebitResult(response.data);
      toast({
        title: "Success",
        description: "Direct Debit charge initiated successfully",
      });
      loadTestData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to initiate direct debit charge",
        variant: "destructive",
      });
      setDirectDebitResult(error.response?.data);
    } finally {
      setLoading(false);
    }
  };

  // Check Payment Status
  const handleCheckPaymentStatus = async () => {
    setLoading(true);
    setStatusResult(null);
    try {
      const response = await api.get(`/hubtel-test/payment/${statusForm.transactionRef}`);
      setStatusResult(response.data);
      toast({
        title: "Success",
        description: "Payment status retrieved",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to check payment status",
        variant: "destructive",
      });
      setStatusResult(error.response?.data);
    } finally {
      setLoading(false);
    }
  };

  // Check Preapproval Status
  const handleCheckPreapprovalStatus = async () => {
    setLoading(true);
    setStatusResult(null);
    try {
      const response = await api.get(`/hubtel-test/preapproval/${statusForm.clientReferenceId}`);
      setStatusResult(response.data);
      toast({
        title: "Success",
        description: "Preapproval status retrieved",
      });
      loadTestData();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to check preapproval status",
        variant: "destructive",
      });
      setStatusResult(error.response?.data);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "SUCCESS":
      case "APPROVED":
      case "PAID":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
            <CheckCircle className="h-3 w-3" /> {status}
          </span>
        );
      case "FAILED":
      case "REJECTED":
      case "CANCELLED":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
            <XCircle className="h-3 w-3" /> {status}
          </span>
        );
      case "PENDING":
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
            <Clock className="h-3 w-3" /> {status}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Hubtel Payment System Test</h1>
        <p className="text-gray-600">Test all Hubtel payment functionalities in one place</p>
      </div>

      {/* Important Notice */}
      <div className="mb-6 p-4 bg-yellow-50 border-l-4 border-yellow-400 rounded">
        <div className="flex">
          <AlertCircle className="h-5 w-5 text-yellow-400 mr-3 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-yellow-800 mb-1">Before Testing</h3>
            <ul className="text-sm text-yellow-700 space-y-1">
              <li>• Ensure your server IP is whitelisted by Hubtel</li>
              <li>• Verify HUBTEL_POS_SALES_ID, HUBTEL_API_KEY, and HUBTEL_API_SECRET are set correctly</li>
              <li>• Make sure the backend test endpoints are deployed</li>
              <li>• Use real Ghana mobile numbers (0244..., 0554..., etc.)</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="flex gap-4 mb-6 border-b overflow-x-auto">
        <button
          onClick={() => setActiveTab("receive-money")}
          className={`pb-3 px-4 font-medium whitespace-nowrap ${
            activeTab === "receive-money"
              ? "border-b-2 border-blue-500 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <CreditCard className="inline h-4 w-4 mr-2" />
          Receive Money
        </button>
        <button
          onClick={() => setActiveTab("preapproval")}
          className={`pb-3 px-4 font-medium whitespace-nowrap ${
            activeTab === "preapproval"
              ? "border-b-2 border-blue-500 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Shield className="inline h-4 w-4 mr-2" />
          Preapproval (Setup)
        </button>
        <button
          onClick={() => setActiveTab("direct-debit")}
          className={`pb-3 px-4 font-medium whitespace-nowrap ${
            activeTab === "direct-debit"
              ? "border-b-2 border-blue-500 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <RefreshCw className="inline h-4 w-4 mr-2" />
          Direct Debit
        </button>
        <button
          onClick={() => setActiveTab("status")}
          className={`pb-3 px-4 font-medium whitespace-nowrap ${
            activeTab === "status"
              ? "border-b-2 border-blue-500 text-blue-600"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <AlertCircle className="inline h-4 w-4 mr-2" />
          Check Status
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {/* Receive Money Tab */}
          {activeTab === "receive-money" && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Test Regular Receive Money Payment</h2>
              <p className="text-sm text-gray-600 mb-4">
                Initiate a regular mobile money payment request. Customer will receive prompt on their phone to approve.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Amount (GHS)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={receiveMoneyForm.amount}
                    onChange={(e) => setReceiveMoneyForm({ ...receiveMoneyForm, amount: e.target.value })}
                    placeholder="10.00"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Customer Phone</label>
                  <Input
                    value={receiveMoneyForm.customerPhone}
                    onChange={(e) => setReceiveMoneyForm({ ...receiveMoneyForm, customerPhone: e.target.value })}
                    placeholder="0244123456"
                  />
                  <p className="text-xs text-gray-500 mt-1">Or select from customers below</p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Network</label>
                  <select
                    className="w-full border rounded-md p-2"
                    value={receiveMoneyForm.network}
                    onChange={(e) => setReceiveMoneyForm({ ...receiveMoneyForm, network: e.target.value })}
                  >
                    <option value="MTN">MTN</option>
                    <option value="VODAFONE">Vodafone</option>
                    <option value="TELECEL">Telecel</option>
                    <option value="AIRTELTIGO">AirtelTigo</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Customer Name (Optional)</label>
                  <Input
                    value={receiveMoneyForm.customerName}
                    onChange={(e) => setReceiveMoneyForm({ ...receiveMoneyForm, customerName: e.target.value })}
                    placeholder="John Doe"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Description (Optional)</label>
                  <Input
                    value={receiveMoneyForm.description}
                    onChange={(e) => setReceiveMoneyForm({ ...receiveMoneyForm, description: e.target.value })}
                    placeholder="Test payment"
                  />
                </div>

                <Button onClick={handleReceiveMoney} disabled={loading} className="w-full">
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...
                    </>
                  ) : (
                    "Initiate Receive Money"
                  )}
                </Button>

                {receiveMoneyResult && (
                  <div className="mt-4 p-4 bg-gray-50 rounded border">
                    <h3 className="font-medium mb-2">Result:</h3>
                    <pre className="text-xs overflow-auto">{JSON.stringify(receiveMoneyResult, null, 2)}</pre>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Preapproval Tab */}
          {activeTab === "preapproval" && (
            <div className="space-y-6">
              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Test Initiate Preapproval (Direct Debit Setup)</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Set up Direct Debit preapproval. Customer will approve via USSD or OTP.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Customer</label>
                    <select
                      className="w-full border rounded-md p-2"
                      value={preapprovalForm.customerId}
                      onChange={(e) => {
                        const customer = customers.find((c) => c.id === e.target.value);
                        setPreapprovalForm({
                          ...preapprovalForm,
                          customerId: e.target.value,
                          customerPhone: customer?.phone || "",
                        });
                      }}
                    >
                      <option value="">Select a customer</option>
                      {customers.map((customer) => (
                        <option key={customer.id} value={customer.id}>
                          {customer.firstName} {customer.lastName} - {customer.phone}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Customer Phone</label>
                    <Input
                      value={preapprovalForm.customerPhone}
                      onChange={(e) => setPreapprovalForm({ ...preapprovalForm, customerPhone: e.target.value })}
                      placeholder="0244123456"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Network</label>
                    <select
                      className="w-full border rounded-md p-2"
                      value={preapprovalForm.network}
                      onChange={(e) => setPreapprovalForm({ ...preapprovalForm, network: e.target.value })}
                    >
                      <option value="MTN">MTN</option>
                      <option value="VODAFONE">Vodafone</option>
                      <option value="TELECEL">Telecel</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">Direct Debit only supports MTN, Vodafone, and Telecel</p>
                  </div>

                  <Button onClick={handleInitiatePreapproval} disabled={loading} className="w-full">
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...
                      </>
                    ) : (
                      "Initiate Preapproval"
                    )}
                  </Button>

                  {preapprovalResult && (
                    <div className="mt-4 p-4 bg-gray-50 rounded border">
                      <h3 className="font-medium mb-2">Result:</h3>
                      <pre className="text-xs overflow-auto">{JSON.stringify(preapprovalResult, null, 2)}</pre>
                    </div>
                  )}
                </div>
              </Card>

              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Verify OTP (For OTP Verification Type)</h2>
                <p className="text-sm text-gray-600 mb-4">
                  If verification type is OTP, use this form to verify. USSD verifications happen automatically.
                </p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Client Reference ID</label>
                    <Input
                      value={otpForm.clientReferenceId}
                      onChange={(e) => setOtpForm({ ...otpForm, clientReferenceId: e.target.value })}
                      placeholder="TEST-PREAPPR-..."
                    />
                    <p className="text-xs text-gray-500 mt-1">From preapproval initiation result</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">OTP Code</label>
                    <Input
                      value={otpForm.otpCode}
                      onChange={(e) => setOtpForm({ ...otpForm, otpCode: e.target.value })}
                      placeholder="123456"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Phone Number</label>
                    <Input
                      value={otpForm.phoneNumber}
                      onChange={(e) => setOtpForm({ ...otpForm, phoneNumber: e.target.value })}
                      placeholder="0244123456"
                    />
                  </div>

                  <Button onClick={handleVerifyOTP} disabled={loading} className="w-full">
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying...
                      </>
                    ) : (
                      "Verify OTP"
                    )}
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {/* Direct Debit Tab */}
          {activeTab === "direct-debit" && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-4">Test Direct Debit Charge</h2>
              <p className="text-sm text-gray-600 mb-4">
                Charge a customer who has approved Direct Debit preapproval. No customer action required.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Amount (GHS)</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={directDebitForm.amount}
                    onChange={(e) => setDirectDebitForm({ ...directDebitForm, amount: e.target.value })}
                    placeholder="10.00"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Customer Phone</label>
                  <Input
                    value={directDebitForm.customerPhone}
                    onChange={(e) => setDirectDebitForm({ ...directDebitForm, customerPhone: e.target.value })}
                    placeholder="0244123456"
                  />
                  <p className="text-xs text-gray-500 mt-1">Must have approved preapproval</p>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Network</label>
                  <select
                    className="w-full border rounded-md p-2"
                    value={directDebitForm.network}
                    onChange={(e) => setDirectDebitForm({ ...directDebitForm, network: e.target.value })}
                  >
                    <option value="MTN">MTN</option>
                    <option value="VODAFONE">Vodafone</option>
                    <option value="TELECEL">Telecel</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Customer Name (Optional)</label>
                  <Input
                    value={directDebitForm.customerName}
                    onChange={(e) => setDirectDebitForm({ ...directDebitForm, customerName: e.target.value })}
                    placeholder="John Doe"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Description (Optional)</label>
                  <Input
                    value={directDebitForm.description}
                    onChange={(e) => setDirectDebitForm({ ...directDebitForm, description: e.target.value })}
                    placeholder="Test direct debit"
                  />
                </div>

                <Button onClick={handleDirectDebitCharge} disabled={loading} className="w-full">
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...
                    </>
                  ) : (
                    "Initiate Direct Debit Charge"
                  )}
                </Button>

                {directDebitResult && (
                  <div className="mt-4 p-4 bg-gray-50 rounded border">
                    <h3 className="font-medium mb-2">Result:</h3>
                    <pre className="text-xs overflow-auto">{JSON.stringify(directDebitResult, null, 2)}</pre>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Status Tab */}
          {activeTab === "status" && (
            <div className="space-y-6">
              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Check Payment Status</h2>
                <p className="text-sm text-gray-600 mb-4">Check the status of a payment transaction.</p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Transaction Reference</label>
                    <Input
                      value={statusForm.transactionRef}
                      onChange={(e) => setStatusForm({ ...statusForm, transactionRef: e.target.value })}
                      placeholder="TXN-..."
                    />
                  </div>

                  <Button onClick={handleCheckPaymentStatus} disabled={loading} className="w-full">
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking...
                      </>
                    ) : (
                      "Check Payment Status"
                    )}
                  </Button>
                </div>
              </Card>

              <Card className="p-6">
                <h2 className="text-xl font-semibold mb-4">Check Preapproval Status</h2>
                <p className="text-sm text-gray-600 mb-4">Check the status of a preapproval request.</p>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Client Reference ID</label>
                    <Input
                      value={statusForm.clientReferenceId}
                      onChange={(e) => setStatusForm({ ...statusForm, clientReferenceId: e.target.value })}
                      placeholder="TEST-PREAPPR-..."
                    />
                  </div>

                  <Button onClick={handleCheckPreapprovalStatus} disabled={loading} className="w-full">
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking...
                      </>
                    ) : (
                      "Check Preapproval Status"
                    )}
                  </Button>
                </div>
              </Card>

              {statusResult && (
                <Card className="p-6">
                  <h3 className="font-semibold mb-4">Status Result:</h3>
                  <pre className="text-xs overflow-auto p-4 bg-gray-50 rounded border">
                    {JSON.stringify(statusResult, null, 2)}
                  </pre>
                </Card>
              )}
            </div>
          )}
        </div>

        {/* Sidebar - Quick Reference */}
        <div className="space-y-6">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2">
                <Users className="h-4 w-4" /> Test Customers
              </h3>
              <Button variant="ghost" size="sm" onClick={loadTestData}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {customers.slice(0, 5).map((customer) => (
                <div
                  key={customer.id}
                  className="p-2 bg-gray-50 rounded text-xs cursor-pointer hover:bg-gray-100"
                  onClick={() => {
                    if (activeTab === "receive-money") {
                      setReceiveMoneyForm({
                        ...receiveMoneyForm,
                        customerPhone: customer.phone,
                        customerName: `${customer.firstName} ${customer.lastName}`,
                      });
                    } else if (activeTab === "preapproval") {
                      setPreapprovalForm({
                        ...preapprovalForm,
                        customerId: customer.id,
                        customerPhone: customer.phone,
                      });
                    } else if (activeTab === "direct-debit") {
                      setDirectDebitForm({
                        ...directDebitForm,
                        customerPhone: customer.phone,
                        customerName: `${customer.firstName} ${customer.lastName}`,
                      });
                    }
                  }}
                >
                  <div className="font-medium">
                    {customer.firstName} {customer.lastName}
                  </div>
                  <div className="text-gray-600">{customer.phone}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2">
                <Shield className="h-4 w-4" /> Recent Preapprovals
              </h3>
              <Button variant="ghost" size="sm" onClick={loadTestData}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {preapprovals.slice(0, 5).map((preapproval) => (
                <div key={preapproval.id} className="p-2 bg-gray-50 rounded text-xs">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium truncate">{preapproval.clientReferenceId}</span>
                    {getStatusBadge(preapproval.status)}
                  </div>
                  <div className="text-gray-600">
                    {preapproval.customer.firstName} {preapproval.customer.lastName}
                  </div>
                  <div className="text-gray-500">{preapproval.verificationType}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold flex items-center gap-2">
                <CreditCard className="h-4 w-4" /> Recent Payments
              </h3>
              <Button variant="ghost" size="sm" onClick={loadTestData}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {payments.slice(0, 5).map((payment) => (
                <div
                  key={payment.id}
                  className="p-2 bg-gray-50 rounded text-xs cursor-pointer hover:bg-gray-100"
                  onClick={() => {
                    setStatusForm({ ...statusForm, transactionRef: payment.transactionRef });
                    setActiveTab("status");
                  }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium">GHS {payment.amount.toFixed(2)}</span>
                    {getStatusBadge(payment.status)}
                  </div>
                  <div className="text-gray-600 truncate">{payment.transactionRef}</div>
                  <div className="text-gray-500">{payment.paymentMethod}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

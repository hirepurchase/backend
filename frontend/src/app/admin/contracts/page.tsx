"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus,
  FileText,
  Calendar,
  DollarSign,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import api from "@/lib/api";
import { formatCurrency, formatDate, getStatusColor } from "@/lib/utils";
import { useToast } from "@/hooks/useToast";

export default function ContractsPage() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const itemsPerPage = 20;
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (searchParams.get("action") === "new") {
      setShowCreateForm(true);
    }
    loadContracts();
  }, [searchParams, currentPage]);

  const loadContracts = async () => {
    try {
      setIsLoading(true);
      const response = await api.get("/contracts", {
        params: {
          search: searchQuery || undefined,
          page: currentPage,
          limit: itemsPerPage,
        },
      });
      setContracts(response.data.contracts || []);
      setTotalPages(response.data.pagination?.totalPages || 1);
      setTotalItems(response.data.pagination?.total || 0);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to load contracts",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    loadContracts();
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleDeleteContract = async (contract: any) => {
    if (contract._count?.payments > 0) {
      toast({
        title: "Cannot Delete",
        description: `This contract has ${contract._count.payments} payment(s). Cannot delete contracts that have received payments.`,
        variant: "destructive",
      });
      return;
    }

    if (
      !confirm(
        `Are you sure you want to delete contract ${contract.contractNumber}? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await api.delete(`/contracts/${contract.id}`);
      toast({
        title: "Success",
        description: "Contract deleted successfully",
      });
      loadContracts();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to delete contract",
        variant: "destructive",
      });
    }
  };

  if (showCreateForm) {
    return (
      <CreateHirePurchaseSale
        onClose={() => setShowCreateForm(false)}
        onSuccess={() => {
          setShowCreateForm(false);
          loadContracts();
        }}
      />
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">
            Hire Purchase Contracts
          </h1>
          <p className="text-gray-600 mt-1">
            Manage hire purchase sales and agreements
          </p>
        </div>
        <Button onClick={() => setShowCreateForm(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create New Sale
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <CardTitle>All Contracts</CardTitle>
            </div>
            <div className="flex items-center gap-2 flex-1">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  placeholder="Search by customer name, IMEI/Serial, contract number..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-10"
                />
              </div>
              <Button onClick={handleSearch}>Search</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : contracts.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <FileText className="h-16 w-16 mx-auto mb-4 text-gray-400" />
              <p className="text-lg font-medium">No contracts yet</p>
              <p className="text-sm mt-1">
                Create your first hire purchase sale to get started
              </p>
              <Button className="mt-6" onClick={() => setShowCreateForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create First Contract
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Total Price</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Outstanding</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Start Date</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((contract) => (
                  <TableRow key={contract.id}>
                    <TableCell className="font-mono font-medium">
                      {contract.contractNumber}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full overflow-hidden border border-gray-200 bg-gray-100 flex-shrink-0">
                          {contract.customer?.photoUrl ? (
                            <img
                              src={contract.customer.photoUrl}
                              alt={`${contract.customer.firstName} ${contract.customer.lastName}`}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                e.currentTarget.parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center text-gray-400 text-xs font-semibold">' + (contract.customer?.firstName?.charAt(0) || '') + (contract.customer?.lastName?.charAt(0) || '') + '</div>';
                              }}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs font-semibold">
                              {contract.customer?.firstName?.charAt(0)}{contract.customer?.lastName?.charAt(0)}
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="font-medium">
                            {contract.customer?.firstName}{" "}
                            {contract.customer?.lastName}
                          </p>
                          <p className="text-xs text-gray-500">
                            {contract.customer?.membershipId}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p>{contract.inventoryItem?.product?.name || "-"}</p>
                        <p className="text-xs text-gray-500 font-mono">
                          {contract.inventoryItem?.serialNumber || "-"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>{formatCurrency(contract.totalPrice)}</TableCell>
                    <TableCell className="text-green-600 font-medium">
                      {formatCurrency(contract.totalPaid)}
                    </TableCell>
                    <TableCell className="text-red-600 font-medium">
                      {formatCurrency(contract.outstandingBalance)}
                    </TableCell>
                    <TableCell>
                      <Badge className={getStatusColor(contract.status)}>
                        {contract.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatDate(contract.startDate)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            router.push(`/admin/contracts/${contract.id}`)
                          }
                        >
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 hover:bg-red-50"
                          onClick={() => handleDeleteContract(contract)}
                          disabled={contract._count?.payments > 0}
                        >
                          <Trash2 className="h-3 w-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {!isLoading && contracts.length > 0 && (
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
            totalItems={totalItems}
            itemsPerPage={itemsPerPage}
          />
        )}
      </Card>
    </div>
  );
}

// Hire Purchase Sale Creation Component
function CreateHirePurchaseSale({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState(1);
  const [customers, setCustomers] = useState<any[]>([]);
  const [availableInventory, setAvailableInventory] = useState<any[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);
  const [selectedInventory, setSelectedInventory] = useState<any>(null);
  const [installmentSchedule, setInstallmentSchedule] = useState<any[]>([]);

  const [formData, setFormData] = useState({
    customerId: "",
    inventoryItemId: "",
    totalPrice: "",
    depositAmount: "",
    paymentFrequency: "MONTHLY" as "DAILY" | "WEEKLY" | "MONTHLY",
    totalInstallments: "",
    gracePeriodDays: "0",
    penaltyPercentage: "0",
    startDate: new Date().toISOString().split("T")[0],
    paymentMethod: "" as "" | "HUBTEL_REGULAR" | "HUBTEL_DIRECT_DEBIT" | "MANUAL" | "CASH",
    mobileMoneyNetwork: "" as "" | "MTN" | "VODAFONE" | "TELECEL" | "AIRTELTIGO",
    mobileMoneyNumber: "",
    lockStatus: "" as "" | "LOCKED" | "UNLOCKED",
    registeredUnder: "",
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string>("");
  const [isDraggingSignature, setIsDraggingSignature] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadCustomers();
    loadAvailableInventory();
  }, []);

  const loadCustomers = async () => {
    try {
      const response = await api.get("/customers", { params: { limit: 100 } });
      setCustomers(response.data.customers || []);
    } catch (error) {
      console.error("Failed to load customers:", error);
    }
  };

  const loadAvailableInventory = async () => {
    try {
      const response = await api.get("/products/inventory", {
        params: { status: "AVAILABLE", limit: 1000 }, // Increase limit to show all available items
      });

      // Handle different response formats
      const inventoryData = Array.isArray(response.data)
        ? response.data
        : response.data?.items || [];

      setAvailableInventory(inventoryData);
    } catch (error) {
      console.error("Failed to load inventory:", error);
      setAvailableInventory([]);
    }
  };

  const validateSignatureFile = (file: File): boolean => {
    const validTypes = ["image/jpeg", "image/jpg", "image/png"];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Invalid File Type",
        description: "Please upload a JPEG or PNG image only",
        variant: "destructive",
      });
      return false;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Signature image must be less than 5MB",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  const handleSignatureChange = (file: File) => {
    if (validateSignatureFile(file)) {
      setSignatureFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setSignaturePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSignatureFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleSignatureChange(file);
  };

  const handleSignatureDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSignature(false);
    const file = e.dataTransfer.files[0];
    if (file) handleSignatureChange(file);
  };

  const handleSignatureDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingSignature(true);
  };

  const handleSignatureDragLeave = () => {
    setIsDraggingSignature(false);
  };

  const handleSignatureCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.play();

      const captureBtn = document.createElement("button");
      captureBtn.textContent = "Capture Signature";
      captureBtn.style.cssText =
        "margin-top:1rem;padding:0.5rem 1rem;background:#3b82f6;color:white;border:none;border-radius:0.375rem;cursor:pointer;";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText =
        "margin-top:1rem;margin-left:0.5rem;padding:0.5rem 1rem;background:#6b7280;color:white;border:none;border-radius:0.375rem;cursor:pointer;";

      const modal = document.createElement("div");
      modal.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem;";
      video.style.cssText =
        "max-width:90%;max-height:70vh;border-radius:0.5rem;";

      const btnContainer = document.createElement("div");
      btnContainer.appendChild(captureBtn);
      btnContainer.appendChild(cancelBtn);

      modal.appendChild(video);
      modal.appendChild(btnContainer);
      document.body.appendChild(modal);

      captureBtn.onclick = () => {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);

        canvas.toBlob((blob) => {
          if (blob) {
            const file = new File([blob], "signature.jpg", {
              type: "image/jpeg",
            });
            handleSignatureChange(file);
          }
          stream.getTracks().forEach((track) => track.stop());
          document.body.removeChild(modal);
        }, "image/jpeg");
      };

      cancelBtn.onclick = () => {
        stream.getTracks().forEach((track) => track.stop());
        document.body.removeChild(modal);
      };
    } catch (error) {
      toast({
        title: "Camera Error",
        description: "Could not access camera",
        variant: "destructive",
      });
    }
  };

  const calculateInstallments = () => {
    const totalPrice = parseFloat(formData.totalPrice) || 0;
    const deposit = parseFloat(formData.depositAmount) || 0;
    const financeAmount = totalPrice - deposit;
    const installments = parseInt(formData.totalInstallments) || 1;
    const installmentAmount = financeAmount / installments;

    const schedule = [];
    const startDate = new Date(formData.startDate);

    for (let i = 0; i < installments; i++) {
      const dueDate = new Date(startDate);

      if (formData.paymentFrequency === "DAILY") {
        dueDate.setDate(dueDate.getDate() + i);
      } else if (formData.paymentFrequency === "WEEKLY") {
        dueDate.setDate(dueDate.getDate() + i * 7);
      } else if (formData.paymentFrequency === "MONTHLY") {
        dueDate.setMonth(dueDate.getMonth() + i);
      }

      schedule.push({
        installmentNo: i + 1,
        dueDate: dueDate.toISOString().split("T")[0],
        amount: installmentAmount,
      });
    }

    setInstallmentSchedule(schedule);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);

    try {
      const submitData = new FormData();
      submitData.append("customerId", formData.customerId);
      submitData.append("inventoryItemId", formData.inventoryItemId);
      submitData.append("totalPrice", formData.totalPrice);
      submitData.append("depositAmount", formData.depositAmount);
      submitData.append("paymentFrequency", formData.paymentFrequency);
      submitData.append("totalInstallments", formData.totalInstallments);
      submitData.append("gracePeriodDays", formData.gracePeriodDays);
      submitData.append("penaltyPercentage", formData.penaltyPercentage);
      submitData.append("startDate", formData.startDate);

      // Add payment method fields if selected
      if (formData.paymentMethod) {
        submitData.append("paymentMethod", formData.paymentMethod);
      }
      if (formData.mobileMoneyNetwork) {
        submitData.append("mobileMoneyNetwork", formData.mobileMoneyNetwork);
      }
      if (formData.mobileMoneyNumber) {
        submitData.append("mobileMoneyNumber", formData.mobileMoneyNumber);
      }

      // Add inventory additional info fields if provided
      if (formData.lockStatus) {
        submitData.append("lockStatus", formData.lockStatus);
      }
      if (formData.registeredUnder) {
        submitData.append("registeredUnder", formData.registeredUnder);
      }

      if (signatureFile) {
        submitData.append("signature", signatureFile);
      }

      const response = await api.post("/contracts", submitData, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      toast({
        title: "Contract Created!",
        description: `Contract ${response.data.contractNumber} has been created successfully.`,
      });

      onSuccess();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to create contract",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredCustomers = customers.filter(
    (c) =>
      c.membershipId.toLowerCase().includes(searchQuery.toLowerCase()) ||
      `${c.firstName} ${c.lastName}`
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      c.phone.includes(searchQuery)
  );

  const financeAmount =
    (parseFloat(formData.totalPrice) || 0) -
    (parseFloat(formData.depositAmount) || 0);
  const installmentAmount =
    financeAmount / (parseInt(formData.totalInstallments) || 1);

  return (
    <div className="p-8">
      <Card className="max-w-4xl mx-auto">
        <CardHeader>
          <CardTitle className="text-2xl">Create Hire Purchase Sale</CardTitle>
          <div className="flex gap-2 mt-4">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`h-2 flex-1 rounded-full ${
                  s <= step ? "bg-blue-600" : "bg-gray-200"
                }`}
              />
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {/* Step 1: Select Customer */}
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-lg">Step 1: Select Customer</h3>
              <div>
                <input
                  type="text"
                  placeholder="Search by Membership ID, Name, or Phone..."
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {filteredCustomers.map((customer) => (
                  <div
                    key={customer.id}
                    className={`p-4 border rounded-lg cursor-pointer transition-all ${
                      formData.customerId === customer.id
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:border-blue-300"
                    }`}
                    onClick={() => {
                      setFormData({ ...formData, customerId: customer.id });
                      setSelectedCustomer(customer);
                    }}
                  >
                    <div className="flex gap-4 items-start">
                      <div className="flex-shrink-0">
                        {customer.photoUrl ? (
                          <img
                            src={customer.photoUrl}
                            alt={`${customer.firstName} ${customer.lastName}`}
                            className="w-20 h-20 rounded-lg object-cover border-2 border-gray-200"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              e.currentTarget.parentElement!.innerHTML = '<div class="w-20 h-20 rounded-lg border-2 border-gray-200 bg-gray-100 flex items-center justify-center text-gray-400 text-xl font-semibold">' + customer.firstName.charAt(0) + customer.lastName.charAt(0) + '</div>';
                            }}
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-lg border-2 border-gray-200 bg-gray-100 flex items-center justify-center text-gray-400 text-xl font-semibold">
                            {customer.firstName.charAt(0)}{customer.lastName.charAt(0)}
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium">
                          {customer.firstName} {customer.lastName}
                        </p>
                        <p className="text-sm text-gray-500">
                          ID: {customer.membershipId}
                        </p>
                        <p className="text-sm text-gray-500">
                          Phone: {customer.phone}
                        </p>
                        {customer.email && (
                          <p className="text-sm text-gray-500">
                            Email: {customer.email}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-4">
                <Button variant="outline" onClick={onClose} className="flex-1">
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep(2)}
                  disabled={!formData.customerId}
                  className="flex-1"
                >
                  Next: Select Product
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Select Product & Inventory */}
          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-lg">
                Step 2: Select Product & Serial Number
              </h3>

              {/* Search Input */}
              <div>
                <input
                  type="text"
                  placeholder="Search by product name, category, or serial/IMEI number..."
                  className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                  value={productSearchQuery}
                  onChange={(e) => setProductSearchQuery(e.target.value)}
                />
              </div>

              {/* Filtered Inventory List */}
              <div className="max-h-96 overflow-y-auto space-y-2">
                {(Array.isArray(availableInventory) ? availableInventory : [])
                  .filter((item) => {
                    if (!productSearchQuery) return true;
                    const query = productSearchQuery.toLowerCase();
                    return (
                      item.product?.name?.toLowerCase().includes(query) ||
                      item.product?.category?.name
                        ?.toLowerCase()
                        .includes(query) ||
                      item.serialNumber?.toLowerCase().includes(query)
                    );
                  })
                  .map((item) => (
                    <div
                      key={item.id}
                      className={`p-4 border rounded-lg cursor-pointer transition-all ${
                        formData.inventoryItemId === item.id
                          ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:border-blue-300"
                      }`}
                      onClick={() => {
                        setFormData({
                          ...formData,
                          inventoryItemId: item.id,
                          totalPrice: item.product?.basePrice?.toString() || "",
                          lockStatus: item.lockStatus || "UNLOCKED",
                          registeredUnder: item.registeredUnder || "",
                        });
                        setSelectedInventory(item);
                      }}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="font-medium text-lg">
                            {item.product?.name}
                          </p>
                          <p className="text-sm text-gray-600 mt-1">
                            <span className="font-semibold">Serial/IMEI:</span>{" "}
                            <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">
                              {item.serialNumber}
                            </span>
                          </p>
                          <div className="flex gap-3 mt-2 text-sm">
                            <p className="text-gray-500">
                              Category: {item.product?.category?.name}
                            </p>
                            {item.lockStatus && (
                              <Badge
                                variant={item.lockStatus === 'LOCKED' ? 'destructive' : 'default'}
                                className={item.lockStatus === 'UNLOCKED' ? 'bg-green-100 text-green-800' : ''}
                              >
                                {item.lockStatus}
                              </Badge>
                            )}
                          </div>
                          {item.registeredUnder && (
                            <p className="text-xs text-gray-500 mt-1">
                              Registered: {item.registeredUnder}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-lg">
                            {formatCurrency(item.product?.basePrice || 0)}
                          </p>
                          <Badge className={getStatusColor(item.status)}>
                            {item.status}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>

              {(Array.isArray(availableInventory)
                ? availableInventory
                : []
              ).filter((item) => {
                if (!productSearchQuery) return true;
                const query = productSearchQuery.toLowerCase();
                return (
                  item.product?.name?.toLowerCase().includes(query) ||
                  item.product?.category?.name?.toLowerCase().includes(query) ||
                  item.serialNumber?.toLowerCase().includes(query)
                );
              }).length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <p>No inventory items found matching your search</p>
                </div>
              )}

              <div className="flex gap-4">
                <Button
                  variant="outline"
                  onClick={() => setStep(1)}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={() => setStep(3)}
                  disabled={!formData.inventoryItemId}
                  className="flex-1"
                >
                  Next: Payment Terms
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Configure Payment Terms */}
          {step === 3 && (
            <div className="space-y-6">
              <h3 className="font-semibold text-lg">
                Step 3: Configure Payment Terms
              </h3>

              <div className="bg-blue-50 p-4 rounded-lg">
                <p className="text-sm font-medium text-blue-900">
                  Selected Customer:
                </p>
                <p className="text-lg">
                  {selectedCustomer?.firstName} {selectedCustomer?.lastName}
                </p>
                <p className="text-sm text-blue-700">
                  {selectedCustomer?.membershipId}
                </p>
              </div>

              <div className="bg-green-50 p-4 rounded-lg">
                <p className="text-sm font-medium text-green-900">
                  Selected Product:
                </p>
                <p className="text-lg">{selectedInventory?.product?.name}</p>
                <p className="text-sm text-green-700 font-mono">
                  {selectedInventory?.serialNumber}
                </p>
              </div>

              {/* Additional Inventory Info */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <h4 className="text-sm font-semibold mb-3 text-gray-700">Additional Device Info (Optional)</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Lock Status
                    </label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-white px-3 py-1 text-sm"
                      value={formData.lockStatus}
                      onChange={(e) =>
                        setFormData({ ...formData, lockStatus: e.target.value as "" | "LOCKED" | "UNLOCKED" })
                      }
                    >
                      <option value="">Not specified</option>
                      <option value="UNLOCKED">Unlocked</option>
                      <option value="LOCKED">Locked</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Registered Under
                    </label>
                    <Input
                      placeholder="e.g., Customer Name"
                      value={formData.registeredUnder}
                      onChange={(e) =>
                        setFormData({ ...formData, registeredUnder: e.target.value })
                      }
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  These details can be updated independently later if needed
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Total Price (GHS) *
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    required
                    value={formData.totalPrice}
                    onChange={(e) =>
                      setFormData({ ...formData, totalPrice: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Deposit Amount (GHS) *
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    required
                    value={formData.depositAmount}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        depositAmount: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Payment Frequency *
                  </label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    value={formData.paymentFrequency}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        paymentFrequency: e.target.value as any,
                      })
                    }
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Total Installments *
                  </label>
                  <Input
                    type="number"
                    required
                    value={formData.totalInstallments}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        totalInstallments: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Start Date *
                  </label>
                  <Input
                    type="date"
                    required
                    value={formData.startDate}
                    onChange={(e) =>
                      setFormData({ ...formData, startDate: e.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Grace Period (Days)
                  </label>
                  <Input
                    type="number"
                    value={formData.gracePeriodDays}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        gracePeriodDays: e.target.value,
                      })
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Penalty (%)
                  </label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.penaltyPercentage}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        penaltyPercentage: e.target.value,
                      })
                    }
                  />
                </div>
              </div>

              {/* Payment Method Section */}
              <div className="border-t pt-4 mt-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-4 text-blue-900">Payment Method (Optional)</h3>
                  <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Select Payment Method
                    </label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      value={formData.paymentMethod}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          paymentMethod: e.target.value as any,
                          mobileMoneyNetwork: "",
                          mobileMoneyNumber: "",
                        })
                      }
                    >
                      <option value="">None (Manual Payment)</option>
                      <option value="HUBTEL_REGULAR">Hubtel - Regular Payment (PIN each time)</option>
                      <option value="HUBTEL_DIRECT_DEBIT">Hubtel - Direct Debit (Auto-debit)</option>
                      <option value="CASH">Cash Payment</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      {formData.paymentMethod === "HUBTEL_REGULAR" && "Customer will enter PIN for each payment"}
                      {formData.paymentMethod === "HUBTEL_DIRECT_DEBIT" && "One-time approval, then automatic deduction for installments"}
                      {formData.paymentMethod === "CASH" && "Customer will pay in cash"}
                      {!formData.paymentMethod && "Payments will be recorded manually by admin"}
                    </p>
                  </div>

                  {(formData.paymentMethod === "HUBTEL_REGULAR" ||
                    formData.paymentMethod === "HUBTEL_DIRECT_DEBIT") && (
                    <>
                      <div>
                        <label className="block text-sm font-medium mb-2">
                          Mobile Money Network *
                        </label>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                          value={formData.mobileMoneyNetwork}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              mobileMoneyNetwork: e.target.value as any,
                            })
                          }
                          required
                        >
                          <option value="">Select Network</option>
                          <option value="MTN">MTN Mobile Money</option>
                          <option value="VODAFONE">Telecel (Vodafone)</option>
                          {formData.paymentMethod === "HUBTEL_REGULAR" && (
                            <option value="AIRTELTIGO">AirtelTigo</option>
                          )}
                        </select>
                        {formData.paymentMethod === "HUBTEL_DIRECT_DEBIT" && (
                          <p className="text-xs text-amber-600 mt-1">
                            Note: Direct Debit only supports MTN and Telecel
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-2">
                          Mobile Money Number *
                        </label>
                        <Input
                          type="tel"
                          placeholder="e.g., 0241234567"
                          value={formData.mobileMoneyNumber}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              mobileMoneyNumber: e.target.value,
                            })
                          }
                          required
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Customer's mobile money number for payments
                        </p>
                      </div>

                      {formData.paymentMethod === "HUBTEL_DIRECT_DEBIT" && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                          <p className="text-sm text-blue-800">
                            <strong>Direct Debit Setup:</strong> After contract creation,
                            you'll need to initiate a one-time preapproval request.
                            The customer will approve via USSD or OTP, then future
                            installments will be automatically deducted.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                <p className="font-semibold">Summary:</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>Total Price:</div>
                  <div className="font-medium">
                    {formatCurrency(parseFloat(formData.totalPrice) || 0)}
                  </div>
                  <div>Deposit:</div>
                  <div className="font-medium">
                    {formatCurrency(parseFloat(formData.depositAmount) || 0)}
                  </div>
                  <div>Finance Amount:</div>
                  <div className="font-medium text-blue-600">
                    {formatCurrency(financeAmount)}
                  </div>
                  <div>Installment Amount:</div>
                  <div className="font-medium text-green-600">
                    {formatCurrency(installmentAmount)}
                  </div>
                  <div>Payment Frequency:</div>
                  <div className="font-medium">{formData.paymentFrequency}</div>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={calculateInstallments}
                className="w-full"
                disabled={!formData.totalInstallments || !formData.totalPrice}
              >
                <Calendar className="mr-2 h-4 w-4" />
                Preview Installment Schedule
              </Button>

              {installmentSchedule.length > 0 && (
                <div className="border rounded-lg p-4 max-h-64 overflow-y-auto">
                  <p className="font-medium mb-2">
                    Installment Schedule Preview:
                  </p>
                  <div className="space-y-1 text-sm">
                    {installmentSchedule.map((inst) => (
                      <div
                        key={inst.installmentNo}
                        className="flex justify-between"
                      >
                        <span>Installment #{inst.installmentNo}</span>
                        <span>{inst.dueDate}</span>
                        <span className="font-medium">
                          {formatCurrency(inst.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-2">
                  Customer Signature (Optional)
                </label>
                <div
                  onDrop={handleSignatureDrop}
                  onDragOver={handleSignatureDragOver}
                  onDragLeave={handleSignatureDragLeave}
                  className={`border-2 border-dashed rounded-lg p-6 text-center ${
                    isDraggingSignature
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-300"
                  }`}
                >
                  {signaturePreview ? (
                    <div className="space-y-4">
                      <img
                        src={signaturePreview}
                        alt="Customer signature"
                        className="max-w-xs mx-auto rounded border-2 border-gray-200"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSignatureFile(null);
                          setSignaturePreview("");
                        }}
                      >
                        Remove Signature
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-gray-600">
                        Drag & drop signature here, or use options below
                      </p>
                      <div className="flex gap-2 justify-center flex-wrap">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            document.getElementById("signature-input")?.click()
                          }
                        >
                          Browse Files
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleSignatureCamera}
                        >
                          Take Photo
                        </Button>
                      </div>
                      <p className="text-xs text-gray-500">
                        JPEG or PNG only, max 5MB
                      </p>
                    </div>
                  )}
                  <input
                    id="signature-input"
                    type="file"
                    accept="image/jpeg,image/jpg,image/png"
                    onChange={handleSignatureFileInput}
                    className="hidden"
                  />
                </div>
              </div>

              <div className="flex gap-4">
                <Button
                  variant="outline"
                  onClick={() => setStep(2)}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={handleSubmit}
                  disabled={
                    isSubmitting ||
                    !formData.totalInstallments ||
                    !formData.totalPrice ||
                    ((formData.paymentMethod === "HUBTEL_REGULAR" ||
                      formData.paymentMethod === "HUBTEL_DIRECT_DEBIT") &&
                     (!formData.mobileMoneyNetwork || !formData.mobileMoneyNumber))
                  }
                  className="flex-1"
                >
                  {isSubmitting ? "Creating Contract..." : "Create Contract"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

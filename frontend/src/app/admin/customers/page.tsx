"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Search, Pencil, Trash2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Customer } from "@/types";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/hooks/useToast";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const itemsPerPage = 20;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  useEffect(() => {
    if (searchParams.get("action") === "new") {
      setShowForm(true);
    }
    loadCustomers();
  }, [searchParams, currentPage]);

  const loadCustomers = async () => {
    try {
      setIsLoading(true);
      const response = await api.get("/customers", {
        params: {
          search: searchQuery || undefined,
          page: currentPage,
          limit: itemsPerPage,
        },
      });
      setCustomers(response.data.customers || []);
      setTotalPages(response.data.pagination?.totalPages || 1);
      setTotalItems(response.data.pagination?.total || 0);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to load customers",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1);
    loadCustomers();
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  const handleDeleteCustomer = async (customer: any) => {
    if (customer.contractsCount > 0) {
      toast({
        title: "Cannot Delete",
        description: `This customer has ${customer.contractsCount} contract(s). Cannot delete customers with existing contracts.`,
        variant: "destructive",
      });
      return;
    }

    if (
      !confirm(
        `Are you sure you want to delete ${customer.firstName} ${customer.lastName}? This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await api.delete(`/customers/${customer.id}`);
      toast({
        title: "Success",
        description: "Customer deleted successfully",
      });
      loadCustomers();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to delete customer",
        variant: "destructive",
      });
    }
  };

  if (showForm) {
    return (
      <CustomerRegistrationForm
        onClose={() => setShowForm(false)}
        onSuccess={() => {
          setShowForm(false);
          loadCustomers();
        }}
      />
    );
  }

  if (editingCustomer) {
    return (
      <CustomerEditForm
        customer={editingCustomer}
        onClose={() => setEditingCustomer(null)}
        onSuccess={() => {
          setEditingCustomer(null);
          loadCustomers();
        }}
      />
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Customers</h1>
          <p className="text-gray-600 mt-1">
            Manage customer accounts and memberships
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Register Customer
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  placeholder="Search by name, membership ID, phone..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-10"
                />
              </div>
            </div>
            <Button onClick={handleSearch}>Search</Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : customers.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <p>No customers found</p>
              <Button className="mt-4" onClick={() => setShowForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Register First Customer
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Photo</TableHead>
                  <TableHead>Membership ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Contracts</TableHead>
                  <TableHead>Registered</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell>
                      <div className="w-10 h-10 rounded-full overflow-hidden border border-gray-200 bg-gray-100">
                        {customer.photoUrl ? (
                          <img
                            src={customer.photoUrl}
                            alt={`${customer.firstName} ${customer.lastName}`}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                              e.currentTarget.parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center text-gray-400 text-xs font-semibold">' + customer.firstName.charAt(0) + customer.lastName.charAt(0) + '</div>';
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs font-semibold">
                            {customer.firstName.charAt(0)}{customer.lastName.charAt(0)}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {customer.membershipId}
                    </TableCell>
                    <TableCell>
                      {customer.firstName} {customer.lastName}
                    </TableCell>
                    <TableCell>{customer.phone}</TableCell>
                    <TableCell>{customer.email || "-"}</TableCell>
                    <TableCell>
                      <Badge
                        variant={customer.isActivated ? "default" : "secondary"}
                      >
                        {customer.isActivated ? "Active" : "Pending"}
                      </Badge>
                    </TableCell>
                    <TableCell>{customer.contractsCount || 0}</TableCell>
                    <TableCell>{formatDate(customer.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => router.push(`/admin/customers/${customer.id}`)}
                        >
                          <Eye className="h-3 w-3 mr-1" />
                          View
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingCustomer(customer)}
                        >
                          <Pencil className="h-3 w-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 hover:bg-red-50"
                          onClick={() => handleDeleteCustomer(customer)}
                          disabled={customer.contractsCount > 0}
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
        {!isLoading && customers.length > 0 && (
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

function CustomerRegistrationForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    address: "",
    nationalId: "",
    dateOfBirth: "",
  });
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const fileInputRef = useState<HTMLInputElement | null>(null)[0];

  const validateImageFile = (file: File): boolean => {
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
      // 5MB limit
      toast({
        title: "File Too Large",
        description: "Image must be less than 5MB",
        variant: "destructive",
      });
      return false;
    }
    return true;
  };

  const handlePhotoChange = (file: File | null) => {
    if (!file) return;

    if (!validateImageFile(file)) {
      return;
    }

    setPhotoFile(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setPhotoPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handlePhotoChange(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handlePhotoChange(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleCameraCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.play();

      const captureBtn = document.createElement("button");
      captureBtn.textContent = "Capture Photo";
      captureBtn.style.cssText =
        "margin-top:1rem;padding:0.5rem 1rem;background:#3b82f6;color:white;border:none;border-radius:0.375rem;cursor:pointer;";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText =
        "margin-top:1rem;margin-left:0.5rem;padding:0.5rem 1rem;background:#6b7280;color:white;border:none;border-radius:0.375rem;cursor:pointer;";

      const btnContainer = document.createElement("div");
      btnContainer.appendChild(captureBtn);
      btnContainer.appendChild(cancelBtn);

      const modal = document.createElement("div");
      modal.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;";
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
            const file = new File([blob], "photo.jpg", { type: "image/jpeg" });
            handlePhotoChange(file);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const submitData = new FormData();
      Object.keys(formData).forEach((key) => {
        submitData.append(key, formData[key as keyof typeof formData]);
      });
      if (photoFile) {
        submitData.append("photo", photoFile);
      }

      const response = await api.post("/customers", submitData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast({
        title: "Customer Registered",
        description: `Membership ID: ${response.data.membershipId}`,
      });
      onSuccess();
    } catch (error: any) {
      toast({
        title: "Registration Failed",
        description:
          error.response?.data?.error || "Failed to register customer",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>Register New Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  First Name *
                </label>
                <Input
                  required
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData({ ...formData, firstName: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Last Name *
                </label>
                <Input
                  required
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData({ ...formData, lastName: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Phone Number *
                </label>
                <Input
                  required
                  type="tel"
                  placeholder="0200000000"
                  value={formData.phone}
                  onChange={(e) =>
                    setFormData({ ...formData, phone: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Email</label>
                <Input
                  type="email"
                  placeholder="customer@example.com"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address</label>
              <Input
                value={formData.address}
                onChange={(e) =>
                  setFormData({ ...formData, address: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">
                Customer Photo
              </label>
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                className={`border-2 border-dashed rounded-lg p-6 text-center ${
                  isDragging ? "border-blue-500 bg-blue-50" : "border-gray-300"
                }`}
              >
                {photoPreview ? (
                  <div className="space-y-4">
                    <img
                      src={photoPreview}
                      alt="Customer preview"
                      className="max-w-xs mx-auto rounded"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPhotoFile(null);
                        setPhotoPreview("");
                      }}
                    >
                      Remove Photo
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-gray-600">
                      Drag & drop photo here, or click to browse
                    </p>
                    <div className="flex gap-2 justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          document.getElementById("photo-input")?.click()
                        }
                      >
                        Browse Files
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCameraCapture}
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
                  id="photo-input"
                  type="file"
                  accept="image/jpeg,image/jpg,image/png"
                  onChange={handleFileInput}
                  className="hidden"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  National ID
                </label>
                <Input
                  value={formData.nationalId}
                  onChange={(e) =>
                    setFormData({ ...formData, nationalId: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Date of Birth
                </label>
                <Input
                  type="date"
                  value={formData.dateOfBirth}
                  onChange={(e) =>
                    setFormData({ ...formData, dateOfBirth: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="flex gap-4 pt-4">
              <Button type="submit" disabled={isSubmitting} className="flex-1">
                {isSubmitting ? "Registering..." : "Register Customer"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function CustomerEditForm({
  customer,
  onClose,
  onSuccess,
}: {
  customer: any;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    firstName: customer.firstName || "",
    lastName: customer.lastName || "",
    phone: customer.phone || "",
    address: customer.address || "",
    nationalId: customer.nationalId || "",
    dateOfBirth: customer.dateOfBirth
      ? new Date(customer.dateOfBirth).toISOString().split("T")[0]
      : "",
  });
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(customer.photoUrl || null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setPhotoFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPhotoPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const submitData = new FormData();
      submitData.append("firstName", formData.firstName);
      submitData.append("lastName", formData.lastName);
      submitData.append("phone", formData.phone);
      submitData.append("address", formData.address);
      submitData.append("nationalId", formData.nationalId);
      if (formData.dateOfBirth) {
        submitData.append("dateOfBirth", formData.dateOfBirth);
      }
      if (photoFile) {
        submitData.append("photo", photoFile);
      }

      await api.put(`/customers/${customer.id}`, submitData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });
      toast({
        title: "Success",
        description: "Customer updated successfully",
      });
      onSuccess();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.response?.data?.error || "Failed to update customer",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-8">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle>Edit Customer - {customer.membershipId}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Photo Upload */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Customer Photo
              </label>
              <div className="flex items-center gap-4">
                {photoPreview && (
                  <div className="w-24 h-24 rounded-full overflow-hidden border-2 border-gray-300">
                    <img
                      src={photoPreview}
                      alt="Customer"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="flex-1">
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoChange}
                    className="cursor-pointer"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Upload a new photo to update (optional)
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  First Name *
                </label>
                <Input
                  required
                  value={formData.firstName}
                  onChange={(e) =>
                    setFormData({ ...formData, firstName: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  Last Name *
                </label>
                <Input
                  required
                  value={formData.lastName}
                  onChange={(e) =>
                    setFormData({ ...formData, lastName: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">
                  Phone Number *
                </label>
                <Input
                  required
                  type="tel"
                  placeholder="0200000000"
                  value={formData.phone}
                  onChange={(e) =>
                    setFormData({ ...formData, phone: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">
                  National ID
                </label>
                <Input
                  value={formData.nationalId}
                  onChange={(e) =>
                    setFormData({ ...formData, nationalId: e.target.value })
                  }
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Address</label>
              <Input
                value={formData.address}
                onChange={(e) =>
                  setFormData({ ...formData, address: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">
                Date of Birth
              </label>
              <Input
                type="date"
                value={formData.dateOfBirth}
                onChange={(e) =>
                  setFormData({ ...formData, dateOfBirth: e.target.value })
                }
              />
            </div>
            <div className="flex gap-4 pt-4">
              <Button type="submit" disabled={isSubmitting} className="flex-1">
                {isSubmitting ? "Updating..." : "Update Customer"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

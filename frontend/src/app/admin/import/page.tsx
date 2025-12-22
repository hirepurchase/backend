"use client";

import { useState } from "react";
import {
  Upload,
  Download,
  FileSpreadsheet,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/useToast";
import api from "@/lib/api";

type ImportType = "customers" | "products" | "inventory" | "contracts";

interface ImportResult {
  success: boolean;
  imported: number;
  failed: number;
  errors: string[];
}

export default function ImportPage() {
  const { toast } = useToast();
  const [importing, setImporting] = useState(false);
  const [currentImport, setCurrentImport] = useState<ImportType | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const importTypes = [
    {
      type: "customers" as ImportType,
      title: "Customers",
      description: "Import customer records with membership IDs auto-generated",
      icon: "👥",
      fields:
        "firstName, lastName, phone, email, address, nationalId, dateOfBirth",
    },
    {
      type: "products" as ImportType,
      title: "Products",
      description: "Import product catalog with categories auto-created",
      icon: "📦",
      fields:
        "name, category, description, unitPrice, minDepositPercentage, maxInstallmentPeriod",
    },
    {
      type: "inventory" as ImportType,
      title: "Inventory",
      description: "Import inventory items with serial numbers",
      icon: "📋",
      fields: "productName, serialNumber",
    },
    {
      type: "contracts" as ImportType,
      title: "Contracts",
      description: "Import hire purchase contracts with schedules auto-created",
      icon: "📄",
      fields:
        "customerPhone, productSerial, totalPrice, depositAmount, paymentFrequency, totalInstallments",
    },
  ];

  const downloadTemplate = async (type: ImportType) => {
    try {
      const response = await api.get(`/import/templates/${type}`, {
        responseType: "blob",
      });

      // Create download link
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${type}_import_template.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();

      toast({
        title: "Template Downloaded",
        description: `${type} import template has been downloaded`,
      });
    } catch (error: any) {
      toast({
        title: "Download Failed",
        description:
          error.response?.data?.error || "Failed to download template",
        variant: "destructive",
      });
    }
  };

  const handleFileUpload = async (
    type: ImportType,
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = [
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Invalid File",
        description: "Please upload an Excel file (.xls or .xlsx)",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Maximum file size is 10MB",
        variant: "destructive",
      });
      return;
    }

    try {
      setImporting(true);
      setCurrentImport(type);
      setResult(null);

      const formData = new FormData();
      formData.append("file", file);

      const response = await api.post(`/import/${type}`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      });

      setResult(response.data);

      if (response.data.success) {
        toast({
          title: "Import Successful",
          description: `Successfully imported ${response.data.imported} ${type}`,
        });
      } else {
        toast({
          title: "Import Completed with Errors",
          description: `Imported: ${response.data.imported}, Failed: ${response.data.failed}`,
          variant: "destructive",
        });
      }
    } catch (error: any) {
      toast({
        title: "Import Failed",
        description: error.response?.data?.error || "Failed to import data",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
      setCurrentImport(null);
      // Reset file input
      event.target.value = "";
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          Excel Import
        </h1>
        <p className="text-sm sm:text-base text-gray-600 mt-2">
          Import bulk data from Excel files. Download templates and follow the
          format.
        </p>
      </div>

      {/* Import Order Info */}
      <Card className="mb-6 border-blue-200 bg-blue-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-blue-900">
            <AlertCircle className="h-5 w-5" />
            Important: Import Order
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-blue-800">
            For best results, import in this order:
          </p>
          <ol className="list-decimal list-inside mt-2 space-y-1 text-sm text-blue-900">
            <li>
              <strong>Customers</strong> (first)
            </li>
            <li>
              <strong>Products</strong> (second)
            </li>
            <li>
              <strong>Inventory</strong> (requires products to exist)
            </li>
            <li>
              <strong>Contracts</strong> (requires customers and inventory to
              exist)
            </li>
          </ol>
        </CardContent>
      </Card>

      {/* Import Results */}
      {result && (
        <Card
          className={`mb-6 ${
            result.success
              ? "border-green-200 bg-green-50"
              : "border-yellow-200 bg-yellow-50"
          }`}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {result.success ? (
                <>
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <span className="text-green-900">Import Successful</span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-5 w-5 text-yellow-600" />
                  <span className="text-yellow-900">
                    Import Completed with Errors
                  </span>
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="text-center p-3 bg-white rounded-lg">
                <p className="text-2xl font-bold text-green-600">
                  {result.imported}
                </p>
                <p className="text-sm text-gray-600">Imported</p>
              </div>
              <div className="text-center p-3 bg-white rounded-lg">
                <p className="text-2xl font-bold text-red-600">
                  {result.failed}
                </p>
                <p className="text-sm text-gray-600">Failed</p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="mt-4">
                <p className="font-medium text-sm mb-2 text-gray-900">
                  Errors:
                </p>
                <div className="bg-white rounded-lg p-3 max-h-60 overflow-y-auto">
                  <ul className="space-y-1 text-sm text-red-600">
                    {result.errors.map((error, index) => (
                      <li key={index} className="flex items-start gap-2">
                        <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span>{error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Import Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {importTypes.map((item) => (
          <Card key={item.type} className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="text-2xl">{item.icon}</span>
                {item.title}
              </CardTitle>
              <CardDescription>{item.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <p className="text-xs text-gray-500 mb-1">Required Fields:</p>
                <p className="text-xs text-gray-700 bg-gray-50 p-2 rounded border">
                  {item.fields}
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                {/* Download Template Button */}
                <Button
                  variant="outline"
                  onClick={() => downloadTemplate(item.type)}
                  className="flex-1"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download Template
                </Button>

                {/* Upload File Button */}
                <label className="flex-1">
                  <Button
                    variant="default"
                    className="w-full"
                    disabled={importing && currentImport === item.type}
                    asChild
                  >
                    <span>
                      {importing && currentImport === item.type ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Importing...
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4 mr-2" />
                          Upload File
                        </>
                      )}
                    </span>
                  </Button>
                  <input
                    type="file"
                    accept=".xls,.xlsx"
                    onChange={(e) => handleFileUpload(item.type, e)}
                    disabled={importing}
                    className="hidden"
                  />
                </label>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Help Section */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            How to Import
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                1
              </span>
              <div>
                <p className="font-medium">Download Template</p>
                <p className="text-gray-600">
                  Click "Download Template" to get the Excel template with
                  sample data
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                2
              </span>
              <div>
                <p className="font-medium">Fill Data</p>
                <p className="text-gray-600">
                  Open the template, fill in your data following the format, and
                  save
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                3
              </span>
              <div>
                <p className="font-medium">Upload & Import</p>
                <p className="text-gray-600">
                  Click "Upload File", select your filled template, and import
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-xs font-bold">
                4
              </span>
              <div>
                <p className="font-medium">Review Results</p>
                <p className="text-gray-600">
                  Check import results and fix any errors if needed
                </p>
              </div>
            </li>
          </ol>

          <div className="mt-4 p-3 bg-gray-50 rounded-lg">
            <p className="text-xs text-gray-700">
              <strong>Note:</strong> Maximum file size is 10MB. Only .xls and
              .xlsx files are supported. For large imports, split data into
              multiple files.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

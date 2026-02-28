import * as XLSX from "xlsx";
import prisma from "../config/database";
import bcrypt from "bcryptjs";
import {
  generateMembershipId,
  generateContractNumber,
  sanitizePhoneNumber,
  validatePhoneNumber,
} from "../utils/helpers";

interface ImportResult {
  success: boolean;
  imported: number;
  failed: number;
  errors: string[];
  details?: any;
}

interface CustomerRow {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  nationalId?: string;
  dateOfBirth?: string;
}

interface ProductRow {
  name: string;
  category: string;
  description?: string;
  unitPrice: number;
  minDepositPercentage?: number;
  maxInstallmentPeriod?: number;
}

interface InventoryRow {
  productName: string;
  serialNumber: string;
}

interface ContractRow {
  customerPhone: string; // To identify customer
  productSerial: string; // To identify inventory item
  totalPrice: number;
  depositAmount: number;
  paymentFrequency: string; // DAILY, WEEKLY, MONTHLY
  totalInstallments: number;
  startDate?: string;
  gracePeriodDays?: number;
  penaltyPercentage?: number;
}

/**
 * Import customers from Excel file
 */
export async function importCustomers(
  fileBuffer: Buffer,
  createdById: string
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data: CustomerRow[] = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Processing ${data.length} customers...`);

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        // Validate required fields
        if (!row.firstName || !row.lastName || !row.phone) {
          result.errors.push(
            `Row ${i + 2}: Missing required fields (firstName, lastName, phone)`
          );
          result.failed++;
          continue;
        }

        const normalizedPhone = sanitizePhoneNumber(row.phone);
        if (!validatePhoneNumber(normalizedPhone)) {
          result.errors.push(
            `Row ${i + 2}: Invalid phone number format (${row.phone})`
          );
          result.failed++;
          continue;
        }

        // Check if phone already exists
        const existingCustomer = await prisma.customer.findFirst({
          where: { phone: normalizedPhone },
        });

        if (existingCustomer) {
          result.errors.push(
            `Row ${i + 2}: Phone number ${row.phone} already exists`
          );
          result.failed++;
          continue;
        }

        // Generate unique membership ID
        let membershipId = generateMembershipId();
        let exists = await prisma.customer.findUnique({
          where: { membershipId },
        });
        while (exists) {
          membershipId = generateMembershipId();
          exists = await prisma.customer.findUnique({
            where: { membershipId },
          });
        }

        // Create customer
        await prisma.customer.create({
          data: {
            membershipId,
            firstName: row.firstName.trim().toUpperCase(),
            lastName: row.lastName.trim().toUpperCase(),
            phone: normalizedPhone,
            email: row.email ? row.email.trim().toLowerCase() : null,
            address: row.address || null,
            nationalId: row.nationalId || null,
            dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
            createdById,
          },
        });

        result.imported++;
      } catch (error: any) {
        result.errors.push(`Row ${i + 2}: ${error.message}`);
        result.failed++;
      }
    }

    result.success = result.failed === 0;
    return result;
  } catch (error: any) {
    return {
      success: false,
      imported: 0,
      failed: 0,
      errors: [`Failed to parse Excel file: ${error.message}`],
    };
  }
}

/**
 * Import products from Excel file
 */
export async function importProducts(
  fileBuffer: Buffer,
  createdById: string
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data: ProductRow[] = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Processing ${data.length} products...`);

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        // Validate required fields
        if (!row.name || !row.category || !row.unitPrice) {
          result.errors.push(
            `Row ${i + 2}: Missing required fields (name, category, unitPrice)`
          );
          result.failed++;
          continue;
        }

        // Convert to strings and trim
        const productName = String(row.name).trim();
        const categoryName = String(row.category).trim();
        const description = row.description
          ? String(row.description).trim()
          : null;

        // Check if product already exists
        const existingProduct = await prisma.product.findFirst({
          where: {
            name: productName,
          },
        });

        if (existingProduct) {
          result.errors.push(
            `Row ${i + 2}: Product "${productName}" already exists`
          );
          result.failed++;
          continue;
        }

        // Find or create category
        let category = await prisma.productCategory.findFirst({
          where: { name: categoryName },
        });

        if (!category) {
          category = await prisma.productCategory.create({
            data: {
              name: categoryName,
              description: `Auto-created from import`,
            },
          });
        }

        // Create product
        await prisma.product.create({
          data: {
            name: productName,
            categoryId: category.id,
            description: description,
            basePrice: Number(row.unitPrice),
          },
        });

        result.imported++;
      } catch (error: any) {
        result.errors.push(`Row ${i + 2}: ${error.message}`);
        result.failed++;
      }
    }

    result.success = result.failed === 0;
    return result;
  } catch (error: any) {
    return {
      success: false,
      imported: 0,
      failed: 0,
      errors: [`Failed to parse Excel file: ${error.message}`],
    };
  }
}

/**
 * Import inventory from Excel file
 */
export async function importInventory(
  fileBuffer: Buffer,
  createdById: string
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data: InventoryRow[] = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Processing ${data.length} inventory items...`);

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        if (!row.productName || !row.serialNumber) {
          result.errors.push(
            `Row ${i + 2}: Missing required fields (productName, serialNumber)`
          );
          result.failed++;
          continue;
        }

        const productName = String(row.productName).trim();
        const serialNumber = String(row.serialNumber).trim();

        // Find product by NAME
        const product = await prisma.product.findFirst({
          where: { name: productName },
        });

        if (!product) {
          result.errors.push(
            `Row ${
              i + 2
            }: Product "${productName}" not found. Please import products first.`
          );
          result.failed++;
          continue;
        }

        // Check if serial number already exists
        const existingItem = await prisma.inventoryItem.findFirst({
          where: { serialNumber },
        });

        if (existingItem) {
          result.errors.push(
            `Row ${i + 2}: Serial number ${serialNumber} already exists`
          );
          result.failed++;
          continue;
        }

        // Create inventory item
        await prisma.inventoryItem.create({
          data: {
            productId: product.id,
            serialNumber,
            status: "AVAILABLE",
          },
        });

        result.imported++;
      } catch (error: any) {
        result.errors.push(`Row ${i + 2}: ${error.message}`);
        result.failed++;
      }
    }

    result.success = result.failed === 0;
    return result;
  } catch (error: any) {
    return {
      success: false,
      imported: 0,
      failed: 0,
      errors: [`Failed to parse Excel file: ${error.message}`],
    };
  }
}

/**
 * Import contracts from Excel file
 */
export async function importContracts(
  fileBuffer: Buffer,
  createdById: string
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    imported: 0,
    failed: 0,
    errors: [],
  };

  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data: ContractRow[] = XLSX.utils.sheet_to_json(worksheet);

    console.log(`Processing ${data.length} contracts...`);

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        // Validate required fields
        if (
          !row.customerPhone ||
          !row.productSerial ||
          !row.totalPrice ||
          !row.depositAmount ||
          !row.paymentFrequency ||
          !row.totalInstallments
        ) {
          result.errors.push(`Row ${i + 2}: Missing required fields`);
          result.failed++;
          continue;
        }

        // Convert to strings and trim
        const rawCustomerPhone = String(row.customerPhone).trim();
        const customerPhone = sanitizePhoneNumber(rawCustomerPhone);
        if (!validatePhoneNumber(customerPhone)) {
          result.errors.push(
            `Row ${i + 2}: Invalid phone number format (${rawCustomerPhone})`
          );
          result.failed++;
          continue;
        }
        const productSerial = String(row.productSerial).trim();
        const paymentFrequency = String(row.paymentFrequency)
          .toUpperCase()
          .trim();

        // Find customer by phone
        const customer = await prisma.customer.findFirst({
          where: { phone: customerPhone },
        });

        if (!customer) {
          result.errors.push(
            `Row ${i + 2}: Customer with phone ${customerPhone} not found`
          );
          result.failed++;
          continue;
        }

        // Find inventory item by serial number
        const inventoryItem = await prisma.inventoryItem.findFirst({
          where: {
            serialNumber: productSerial,
            status: "AVAILABLE",
          },
        });

        if (!inventoryItem) {
          result.errors.push(
            `Row ${
              i + 2
            }: Available inventory item with serial ${productSerial} not found`
          );
          result.failed++;
          continue;
        }

        // Validate payment frequency
        const validFrequencies = ["DAILY", "WEEKLY", "MONTHLY"];
        if (!validFrequencies.includes(paymentFrequency)) {
          result.errors.push(
            `Row ${
              i + 2
            }: Invalid payment frequency. Must be DAILY, WEEKLY, or MONTHLY`
          );
          result.failed++;
          continue;
        }

        // Calculate contract details
        const totalPrice = Number(row.totalPrice);
        const depositAmount = Number(row.depositAmount);
        const financeAmount = totalPrice - depositAmount;
        const installmentAmount =
          Math.ceil((financeAmount / Number(row.totalInstallments)) * 100) /
          100;

        // Generate unique contract number
        let contractNumber = generateContractNumber();
        let exists = await prisma.hirePurchaseContract.findUnique({
          where: { contractNumber },
        });
        while (exists) {
          contractNumber = generateContractNumber();
          exists = await prisma.hirePurchaseContract.findUnique({
            where: { contractNumber },
          });
        }

        const startDate = row.startDate ? new Date(row.startDate) : new Date();

        // Calculate end date based on payment frequency
        const endDate = new Date(startDate);
        const installments = Number(row.totalInstallments);
        switch (paymentFrequency) {
          case "DAILY":
            endDate.setDate(endDate.getDate() + installments);
            break;
          case "WEEKLY":
            endDate.setDate(endDate.getDate() + installments * 7);
            break;
          case "MONTHLY":
            endDate.setMonth(endDate.getMonth() + installments);
            break;
        }

        if (!customer.id_uuid) {
          result.errors.push(
            `Row ${i + 2}: Customer UUID missing for phone ${customerPhone}`
          );
          result.failed++;
          continue;
        }

        // Create contract in transaction
        await prisma.$transaction(async (tx) => {
          // Create contract
          const contract = await tx.hirePurchaseContract.create({
            data: {
              contractNumber,
              customerId_uuid: customer.id_uuid,
              totalPrice,
              depositAmount,
              financeAmount,
              installmentAmount,
              paymentFrequency: paymentFrequency as any,
              totalInstallments: Number(row.totalInstallments),
              gracePeriodDays: row.gracePeriodDays
                ? Number(row.gracePeriodDays)
                : 0,
              penaltyPercentage: row.penaltyPercentage
                ? Number(row.penaltyPercentage)
                : 0,
              startDate,
              endDate,
              outstandingBalance: financeAmount,
              totalPaid: depositAmount,
              createdById,
            },
          });

          // Create installment schedule
          const installmentSchedule: Array<{
            contractId: string;
            installmentNo: number;
            dueDate: Date;
            amount: number;
          }> = [];
          let currentDate = new Date(startDate);

          for (let inst = 1; inst <= Number(row.totalInstallments); inst++) {
            installmentSchedule.push({
              contractId: contract.id,
              installmentNo: inst,
              dueDate: new Date(currentDate),
              amount: installmentAmount,
            });

            // Increment date based on frequency
            switch (row.paymentFrequency.toUpperCase()) {
              case "DAILY":
                currentDate.setDate(currentDate.getDate() + 1);
                break;
              case "WEEKLY":
                currentDate.setDate(currentDate.getDate() + 7);
                break;
              case "MONTHLY":
                currentDate.setMonth(currentDate.getMonth() + 1);
                break;
            }
          }

          await tx.installmentSchedule.createMany({
            data: installmentSchedule,
          });

          // Update inventory item status
          await tx.inventoryItem.update({
            where: { id: inventoryItem.id },
            data: {
              status: "SOLD",
              contractId: contract.id,
            },
          });
        });

        result.imported++;
      } catch (error: any) {
        result.errors.push(`Row ${i + 2}: ${error.message}`);
        result.failed++;
      }
    }

    result.success = result.failed === 0;
    return result;
  } catch (error: any) {
    return {
      success: false,
      imported: 0,
      failed: 0,
      errors: [`Failed to parse Excel file: ${error.message}`],
    };
  }
}

/**
 * Generate Excel template for customers
 */
export function generateCustomerTemplate(): Buffer {
  const data = [
    {
      firstName: "John",
      lastName: "Doe",
      phone: "0241234567",
      email: "john.doe@example.com",
      address: "123 Main St, Accra",
      nationalId: "GHA-123456789",
      dateOfBirth: "1990-01-15",
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Customers");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/**
 * Generate Excel template for products
 */
export function generateProductTemplate(): Buffer {
  const data = [
    {
      name: "iPhone 14 Pro",
      category: "Smartphones",
      description: "Latest iPhone model",
      unitPrice: 5000,
      minDepositPercentage: 30,
      maxInstallmentPeriod: 12,
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Products");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/**
 * Generate Excel template for inventory
 */
export function generateInventoryTemplate(): Buffer {
  const data = [
    {
      productName: "iPhone 14 Pro",
      serialNumber: "IPHONE-001",
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Inventory");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

/**
 * Generate Excel template for contracts
 */
export function generateContractTemplate(): Buffer {
  const data = [
    {
      customerPhone: "0241234567",
      productSerial: "IPHONE-001",
      totalPrice: 5000,
      depositAmount: 1500,
      paymentFrequency: "MONTHLY",
      totalInstallments: 10,
      startDate: "2025-01-01",
      gracePeriodDays: 3,
      penaltyPercentage: 5,
    },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Contracts");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

export default {
  importCustomers,
  importProducts,
  importInventory,
  importContracts,
  generateCustomerTemplate,
  generateProductTemplate,
  generateInventoryTemplate,
  generateContractTemplate,
};

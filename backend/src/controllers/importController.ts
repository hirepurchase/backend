import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import {
  importCustomers,
  importProducts,
  importInventory,
  importContracts,
  generateCustomerTemplate,
  generateProductTemplate,
  generateInventoryTemplate,
  generateContractTemplate,
} from '../services/excelImportService';
import { createAuditLog } from '../services/auditService';

// Import customers from Excel
export async function importCustomersFromExcel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const result = await importCustomers(req.file.buffer, req.user!.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'IMPORT_CUSTOMERS',
      entity: 'Customer',
      newValues: {
        imported: result.imported,
        failed: result.failed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(result);
  } catch (error: any) {
    console.error('Import customers error:', error);
    res.status(500).json({ error: 'Failed to import customers' });
  }
}

// Import products from Excel
export async function importProductsFromExcel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const result = await importProducts(req.file.buffer, req.user!.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'IMPORT_PRODUCTS',
      entity: 'Product',
      newValues: {
        imported: result.imported,
        failed: result.failed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(result);
  } catch (error: any) {
    console.error('Import products error:', error);
    res.status(500).json({ error: 'Failed to import products' });
  }
}

// Import inventory from Excel
export async function importInventoryFromExcel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const result = await importInventory(req.file.buffer, req.user!.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'IMPORT_INVENTORY',
      entity: 'InventoryItem',
      newValues: {
        imported: result.imported,
        failed: result.failed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(result);
  } catch (error: any) {
    console.error('Import inventory error:', error);
    res.status(500).json({ error: 'Failed to import inventory' });
  }
}

// Import contracts from Excel
export async function importContractsFromExcel(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const result = await importContracts(req.file.buffer, req.user!.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'IMPORT_CONTRACTS',
      entity: 'HirePurchaseContract',
      newValues: {
        imported: result.imported,
        failed: result.failed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(result);
  } catch (error: any) {
    console.error('Import contracts error:', error);
    res.status(500).json({ error: 'Failed to import contracts' });
  }
}

// Download customer template
export async function downloadCustomerTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const buffer = generateCustomerTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=customer_import_template.xlsx');
    res.send(buffer);
  } catch (error: any) {
    console.error('Download template error:', error);
    res.status(500).json({ error: 'Failed to generate template' });
  }
}

// Download product template
export async function downloadProductTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const buffer = generateProductTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=product_import_template.xlsx');
    res.send(buffer);
  } catch (error: any) {
    console.error('Download template error:', error);
    res.status(500).json({ error: 'Failed to generate template' });
  }
}

// Download inventory template
export async function downloadInventoryTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const buffer = generateInventoryTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=inventory_import_template.xlsx');
    res.send(buffer);
  } catch (error: any) {
    console.error('Download template error:', error);
    res.status(500).json({ error: 'Failed to generate template' });
  }
}

// Download contract template
export async function downloadContractTemplate(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const buffer = generateContractTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=contract_import_template.xlsx');
    res.send(buffer);
  } catch (error: any) {
    console.error('Download template error:', error);
    res.status(500).json({ error: 'Failed to generate template' });
  }
}

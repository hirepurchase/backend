import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';
import { generateContractStatement } from '../services/pdfService';

// Generate and download contract statement
export async function downloadContractStatement(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: true,
        inventoryItem: {
          include: {
            product: {
              include: { category: true },
            },
          },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        payments: {
          where: { status: 'SUCCESS' },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Check ownership for customers
    if (req.userType === 'customer' && contract.customerId !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const statementData = {
      contract: {
        contractNumber: contract.contractNumber,
        totalPrice: contract.totalPrice,
        depositAmount: contract.depositAmount,
        financeAmount: contract.financeAmount,
        installmentAmount: contract.installmentAmount,
        paymentFrequency: contract.paymentFrequency,
        totalInstallments: contract.totalInstallments,
        startDate: contract.startDate,
        endDate: contract.endDate,
        status: contract.status,
        totalPaid: contract.totalPaid,
        outstandingBalance: contract.outstandingBalance,
        ownershipTransferred: contract.ownershipTransferred,
      },
      customer: {
        membershipId: contract.customer.membershipId,
        firstName: contract.customer.firstName,
        lastName: contract.customer.lastName,
        phone: contract.customer.phone,
        email: contract.customer.email,
        address: contract.customer.address,
      },
      product: {
        name: contract.inventoryItem?.product?.name || 'N/A',
        serialNumber: contract.inventoryItem?.serialNumber || 'N/A',
        category: contract.inventoryItem?.product?.category?.name || 'N/A',
      },
      installments: contract.installments.map(i => ({
        installmentNo: i.installmentNo,
        dueDate: i.dueDate,
        amount: i.amount,
        paidAmount: i.paidAmount,
        status: i.status,
        paidAt: i.paidAt,
      })),
      payments: contract.payments.map(p => ({
        transactionRef: p.transactionRef,
        amount: p.amount,
        paymentDate: p.paymentDate,
        status: p.status,
        paymentMethod: p.paymentMethod,
      })),
    };

    const doc = generateContractStatement(statementData);

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="statement-${contract.contractNumber}.pdf"`
    );

    // Pipe the PDF to the response
    doc.pipe(res);
    doc.end();
  } catch (error) {
    console.error('Download statement error:', error);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
}

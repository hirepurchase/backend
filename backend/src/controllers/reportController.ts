import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';

// Sales Report
export async function getSalesReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { startDate, endDate, groupBy = 'day' } = req.query;

    const where: Record<string, unknown> = {};

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, Date>).gte = new Date(startDate as string);
      if (endDate) (where.createdAt as Record<string, Date>).lte = new Date(endDate as string);
    }

    const contracts = await prisma.hirePurchaseContract.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            membershipId: true,
            firstName: true,
            lastName: true,
          },
        },
        inventoryItem: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                category: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate summary statistics
    const summary = {
      totalContracts: contracts.length,
      totalSalesValue: contracts.reduce((sum, c) => sum + c.totalPrice, 0),
      totalDeposits: contracts.reduce((sum, c) => sum + c.depositAmount, 0),
      totalFinanced: contracts.reduce((sum, c) => sum + c.financeAmount, 0),
      averageContractValue: contracts.length > 0
        ? contracts.reduce((sum, c) => sum + c.totalPrice, 0) / contracts.length
        : 0,
      statusBreakdown: {
        active: contracts.filter(c => c.status === 'ACTIVE').length,
        completed: contracts.filter(c => c.status === 'COMPLETED').length,
        defaulted: contracts.filter(c => c.status === 'DEFAULTED').length,
        cancelled: contracts.filter(c => c.status === 'CANCELLED').length,
      },
    };

    // Group by product category
    const byCategory: Record<string, { count: number; value: number }> = {};
    contracts.forEach(c => {
      const categoryName = c.inventoryItem?.product?.category?.name || 'Unknown';
      if (!byCategory[categoryName]) {
        byCategory[categoryName] = { count: 0, value: 0 };
      }
      byCategory[categoryName].count++;
      byCategory[categoryName].value += c.totalPrice;
    });

    // Group by sales person
    const bySalesPerson: Record<string, { count: number; value: number; name: string }> = {};
    contracts.forEach(c => {
      const salesPersonId = c.createdBy.id;
      if (!bySalesPerson[salesPersonId]) {
        bySalesPerson[salesPersonId] = {
          count: 0,
          value: 0,
          name: `${c.createdBy.firstName} ${c.createdBy.lastName}`,
        };
      }
      bySalesPerson[salesPersonId].count++;
      bySalesPerson[salesPersonId].value += c.totalPrice;
    });

    res.json({
      summary,
      byCategory: Object.entries(byCategory).map(([name, data]) => ({
        category: name,
        ...data,
      })),
      bySalesPerson: Object.values(bySalesPerson),
      contracts: contracts.slice(0, 100), // Limit detailed records
    });
  } catch (error) {
    console.error('Get sales report error:', error);
    res.status(500).json({ error: 'Failed to generate sales report' });
  }
}

// Payment Report
export async function getPaymentReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { startDate, endDate, status } = req.query;

    const where: Record<string, unknown> = {};

    if (status) where.status = status;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) (where.createdAt as Record<string, Date>).gte = new Date(startDate as string);
      if (endDate) (where.createdAt as Record<string, Date>).lte = new Date(endDate as string);
    }

    const payments = await prisma.paymentTransaction.findMany({
      where,
      include: {
        contract: {
          select: {
            id: true,
            contractNumber: true,
          },
        },
        customer: {
          select: {
            id: true,
            membershipId: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const successfulPayments = payments.filter(p => p.status === 'SUCCESS');

    const summary = {
      totalTransactions: payments.length,
      successfulTransactions: successfulPayments.length,
      failedTransactions: payments.filter(p => p.status === 'FAILED').length,
      pendingTransactions: payments.filter(p => p.status === 'PENDING').length,
      totalAmountCollected: successfulPayments.reduce((sum, p) => sum + p.amount, 0),
      averagePaymentAmount: successfulPayments.length > 0
        ? successfulPayments.reduce((sum, p) => sum + p.amount, 0) / successfulPayments.length
        : 0,
      byProvider: {
        MTN: successfulPayments.filter(p => p.mobileMoneyProvider === 'MTN').reduce((sum, p) => sum + p.amount, 0),
        VODAFONE: successfulPayments.filter(p => p.mobileMoneyProvider === 'VODAFONE').reduce((sum, p) => sum + p.amount, 0),
        AIRTELTIGO: successfulPayments.filter(p => p.mobileMoneyProvider === 'AIRTELTIGO').reduce((sum, p) => sum + p.amount, 0),
        OTHER: successfulPayments.filter(p => !['MTN', 'VODAFONE', 'AIRTELTIGO'].includes(p.mobileMoneyProvider || '')).reduce((sum, p) => sum + p.amount, 0),
      },
    };

    res.json({
      summary,
      payments: payments.slice(0, 100),
    });
  } catch (error) {
    console.error('Get payment report error:', error);
    res.status(500).json({ error: 'Failed to generate payment report' });
  }
}

// Default Report
export async function getDefaultReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // Get all active contracts with overdue installments
    const contracts = await prisma.hirePurchaseContract.findMany({
      where: {
        status: 'ACTIVE',
        installments: {
          some: {
            status: 'OVERDUE',
          },
        },
      },
      include: {
        customer: {
          select: {
            id: true,
            membershipId: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
        inventoryItem: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        installments: {
          where: { status: 'OVERDUE' },
          orderBy: { dueDate: 'asc' },
        },
        penalties: {
          where: { isPaid: false },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const defaulters = contracts.map(contract => {
      const overdueInstallments = contract.installments;
      const totalOverdueAmount = overdueInstallments.reduce(
        (sum, i) => sum + (i.amount - i.paidAmount),
        0
      );
      const unpaidPenalties = contract.penalties.reduce((sum, p) => sum + p.amount, 0);
      const oldestOverdue = overdueInstallments[0];
      const daysOverdue = oldestOverdue
        ? Math.floor((Date.now() - new Date(oldestOverdue.dueDate).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        contract: {
          id: contract.id,
          contractNumber: contract.contractNumber,
          totalPrice: contract.totalPrice,
          outstandingBalance: contract.outstandingBalance,
        },
        customer: contract.customer,
        product: contract.inventoryItem?.product,
        overdueInstallments: overdueInstallments.length,
        totalOverdueAmount,
        unpaidPenalties,
        totalOwed: totalOverdueAmount + unpaidPenalties,
        oldestOverdueDate: oldestOverdue?.dueDate,
        daysOverdue,
      };
    });

    // Sort by days overdue
    defaulters.sort((a, b) => b.daysOverdue - a.daysOverdue);

    const summary = {
      totalDefaulters: defaulters.length,
      totalOverdueAmount: defaulters.reduce((sum, d) => sum + d.totalOverdueAmount, 0),
      totalPenalties: defaulters.reduce((sum, d) => sum + d.unpaidPenalties, 0),
      byDaysOverdue: {
        '1-7 days': defaulters.filter(d => d.daysOverdue >= 1 && d.daysOverdue <= 7).length,
        '8-30 days': defaulters.filter(d => d.daysOverdue >= 8 && d.daysOverdue <= 30).length,
        '31-60 days': defaulters.filter(d => d.daysOverdue >= 31 && d.daysOverdue <= 60).length,
        '60+ days': defaulters.filter(d => d.daysOverdue > 60).length,
      },
    };

    res.json({
      summary,
      defaulters,
    });
  } catch (error) {
    console.error('Get default report error:', error);
    res.status(500).json({ error: 'Failed to generate default report' });
  }
}

// Inventory Report
export async function getInventoryReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { categoryId, status } = req.query;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const products = await prisma.product.findMany({
      where: categoryId ? { categoryId: categoryId as string } : {},
      include: {
        category: true,
        inventoryItems: {
          where,
        },
      },
      orderBy: { name: 'asc' },
    });

    const inventory = products.map(product => {
      const items = product.inventoryItems;
      return {
        product: {
          id: product.id,
          name: product.name,
          basePrice: product.basePrice,
          category: product.category.name,
          isActive: product.isActive,
        },
        inventory: {
          total: items.length,
          available: items.filter(i => i.status === 'AVAILABLE').length,
          sold: items.filter(i => i.status === 'SOLD').length,
          reserved: items.filter(i => i.status === 'RESERVED').length,
        },
        stockValue: items.filter(i => i.status === 'AVAILABLE').length * product.basePrice,
      };
    });

    const summary = {
      totalProducts: products.length,
      activeProducts: products.filter(p => p.isActive).length,
      totalItems: inventory.reduce((sum, i) => sum + i.inventory.total, 0),
      availableItems: inventory.reduce((sum, i) => sum + i.inventory.available, 0),
      soldItems: inventory.reduce((sum, i) => sum + i.inventory.sold, 0),
      totalStockValue: inventory.reduce((sum, i) => sum + i.stockValue, 0),
      lowStock: inventory.filter(i => i.inventory.available < 5 && i.product.isActive),
      outOfStock: inventory.filter(i => i.inventory.available === 0 && i.product.isActive),
    };

    res.json({
      summary,
      inventory,
    });
  } catch (error) {
    console.error('Get inventory report error:', error);
    res.status(500).json({ error: 'Failed to generate inventory report' });
  }
}

// Dashboard Statistics
export async function getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());

    const [
      totalCustomers,
      totalContracts,
      activeContracts,
      totalProducts,
      availableInventory,
      monthlyPayments,
      weeklyPayments,
      overdueInstallments,
      recentContracts,
    ] = await Promise.all([
      prisma.customer.count(),
      prisma.hirePurchaseContract.count(),
      prisma.hirePurchaseContract.count({ where: { status: 'ACTIVE' } }),
      prisma.product.count({ where: { isActive: true } }),
      prisma.inventoryItem.count({ where: { status: 'AVAILABLE' } }),
      prisma.paymentTransaction.aggregate({
        where: {
          status: 'SUCCESS',
          createdAt: { gte: startOfMonth },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.paymentTransaction.aggregate({
        where: {
          status: 'SUCCESS',
          createdAt: { gte: startOfWeek },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.installmentSchedule.count({ where: { status: 'OVERDUE' } }),
      prisma.hirePurchaseContract.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              membershipId: true,
            },
          },
          inventoryItem: {
            include: {
              product: {
                select: { name: true },
              },
            },
          },
        },
      }),
    ]);

    res.json({
      customers: {
        total: totalCustomers,
      },
      contracts: {
        total: totalContracts,
        active: activeContracts,
      },
      inventory: {
        totalProducts,
        availableItems: availableInventory,
      },
      payments: {
        monthlyTotal: monthlyPayments._sum.amount || 0,
        monthlyCount: monthlyPayments._count,
        weeklyTotal: weeklyPayments._sum.amount || 0,
        weeklyCount: weeklyPayments._count,
      },
      alerts: {
        overdueInstallments,
      },
      recentContracts,
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
  }
}

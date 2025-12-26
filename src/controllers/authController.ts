import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { generateToken } from '../middleware/auth';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest } from '../types';

// Admin Login
export async function adminLogin(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const admin = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
      },
    });

    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!admin.isActive) {
      res.status(401).json({ error: 'Account is deactivated' });
      return;
    }

    const isValidPassword = await bcrypt.compare(password, admin.password);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = generateToken(
      {
        id: admin.id,
        email: admin.email,
        role: admin.role.name,
        permissions: admin.role.permissions.map(p => p.name),
      },
      'admin'
    );

    await createAuditLog({
      userId: admin.id,
      action: 'LOGIN',
      entity: 'AdminUser',
      entityId: admin.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      token,
      user: {
        id: admin.id,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        role: admin.role.name,
        permissions: admin.role.permissions.map(p => p.name),
      },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

// Verify Membership ID (check if it exists and is not activated)
export async function verifyMembershipId(req: Request, res: Response): Promise<void> {
  try {
    const { membershipId } = req.body;

    if (!membershipId) {
      res.status(400).json({ error: 'Membership ID is required' });
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: { membershipId },
      select: {
        id: true,
        membershipId: true,
        firstName: true,
        lastName: true,
        isActivated: true,
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Invalid membership ID. Please check and try again.' });
      return;
    }

    if (customer.isActivated) {
      res.status(400).json({ error: 'This account has already been activated. Please login instead.' });
      return;
    }

    // Return success with customer info (but not sensitive data)
    res.json({
      valid: true,
      customer: {
        membershipId: customer.membershipId,
        firstName: customer.firstName,
        lastName: customer.lastName,
      },
    });
  } catch (error) {
    console.error('Verify membership ID error:', error);
    res.status(500).json({ error: 'Failed to verify membership ID' });
  }
}

// Customer Activation (first-time setup)
export async function activateCustomerAccount(req: Request, res: Response): Promise<void> {
  try {
    const { membershipId, email, password } = req.body;

    if (!membershipId || !email || !password) {
      res.status(400).json({ error: 'Membership ID, email, and password are required' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: { membershipId },
    });

    if (!customer) {
      res.status(404).json({ error: 'Invalid membership ID' });
      return;
    }

    if (customer.isActivated) {
      res.status(400).json({ error: 'Account is already activated' });
      return;
    }

    // Check if email is already in use
    const existingEmail = await prisma.customer.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingEmail && existingEmail.id !== customer.id) {
      res.status(400).json({ error: 'Email is already in use' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const updatedCustomer = await prisma.customer.update({
      where: { id: customer.id },
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        isActivated: true,
        activatedAt: new Date(),
      },
    });

    const token = generateToken(
      {
        id: updatedCustomer.id,
        membershipId: updatedCustomer.membershipId,
        email: updatedCustomer.email,
      },
      'customer'
    );

    await createAuditLog({
      action: 'ACCOUNT_ACTIVATED',
      entity: 'Customer',
      entityId: customer.id,
      newValues: { email: email.toLowerCase(), activatedAt: new Date() },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Account activated successfully',
      token,
      user: {
        id: updatedCustomer.id,
        membershipId: updatedCustomer.membershipId,
        email: updatedCustomer.email,
        firstName: updatedCustomer.firstName,
        lastName: updatedCustomer.lastName,
      },
    });
  } catch (error) {
    console.error('Customer activation error:', error);
    res.status(500).json({ error: 'Account activation failed' });
  }
}

// Customer Login
export async function customerLogin(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!customer) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!customer.isActivated || !customer.password) {
      res.status(401).json({ error: 'Account is not activated' });
      return;
    }

    const isValidPassword = await bcrypt.compare(password, customer.password);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = generateToken(
      {
        id: customer.id,
        membershipId: customer.membershipId,
        email: customer.email,
      },
      'customer'
    );

    await createAuditLog({
      action: 'LOGIN',
      entity: 'Customer',
      entityId: customer.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      token,
      user: {
        id: customer.id,
        membershipId: customer.membershipId,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
      },
    });
  } catch (error) {
    console.error('Customer login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
}

// Get current admin user
export async function getCurrentAdmin(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.user!.id },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
      },
    });

    if (!admin) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      id: admin.id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      phone: admin.phone,
      role: admin.role.name,
      permissions: admin.role.permissions.map(p => p.name),
    });
  } catch (error) {
    console.error('Get current admin error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
}

// Get current customer
export async function getCurrentCustomer(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: req.user!.id },
      include: {
        contracts: {
          include: {
            inventoryItem: {
              include: {
                product: true,
              },
            },
            installments: {
              where: {
                status: {
                  in: ['PENDING', 'OVERDUE'],
                },
              },
              orderBy: {
                dueDate: 'asc',
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        payments: {
          include: {
            contract: {
              include: {
                inventoryItem: {
                  include: {
                    product: true,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Count total contracts
    const contractsCount = customer.contracts.length;
    const activeContracts = customer.contracts.filter(c => c.status === 'ACTIVE').length;

    // Calculate total amount paid
    const totalPaid = customer.payments.reduce((sum, payment) => sum + payment.amount, 0);

    res.json({
      id: customer.id,
      membershipId: customer.membershipId,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      address: customer.address,
      nationalId: customer.nationalId,
      dateOfBirth: customer.dateOfBirth,
      createdAt: customer.createdAt,
      contractsCount,
      activeContracts,
      totalPaid,
      contracts: customer.contracts,
      payments: customer.payments,
    });
  } catch (error) {
    console.error('Get current customer error:', error);
    res.status(500).json({ error: 'Failed to get customer info' });
  }
}

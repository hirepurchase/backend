import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../config/database';
import { generateToken } from '../middleware/auth';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, CustomerPayload } from '../types';
import { sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';
import { sendSMS } from '../services/notificationService';

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

    if (!updatedCustomer.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    const token = generateToken(
      {
        id: updatedCustomer.id_uuid,
        legacyId: updatedCustomer.id,
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
        id: updatedCustomer.id_uuid,
        legacyId: updatedCustomer.id,
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
    const { phone, password } = req.body;

    if (!phone || !password) {
      res.status(400).json({ error: 'Phone number and password are required' });
      return;
    }

    const normalizedPhone = sanitizePhoneNumber(phone);
    if (!validatePhoneNumber(normalizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number format' });
      return;
    }

    const customer = await prisma.customer.findFirst({
      where: { phone: normalizedPhone },
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

    if (!customer.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    const token = generateToken(
      {
        id: customer.id_uuid,
        legacyId: customer.id,
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
        id: customer.id_uuid,
        legacyId: customer.id,
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

// Request password reset OTP via SMS
export async function requestCustomerPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    const { phone } = req.body;

    if (!phone) {
      res.status(400).json({ error: 'Phone number is required' });
      return;
    }

    const normalizedPhone = sanitizePhoneNumber(phone);
    if (!validatePhoneNumber(normalizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number format' });
      return;
    }

    const customer = await prisma.customer.findFirst({
      where: { phone: normalizedPhone },
      select: { id: true, id_uuid: true, isActivated: true },
    });

    // Always return success to avoid user enumeration
    if (!customer || !customer.isActivated) {
      res.json({ message: 'If the account exists, an OTP has been sent' });
      return;
    }

    // Simple rate limiting: max 5 requests per phone per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await prisma.passwordResetOtp.count({
      where: {
        phone: normalizedPhone,
        createdAt: { gt: oneHourAgo },
      },
    });
    if (recentCount >= 5) {
      res.json({ message: 'If the account exists, an OTP has been sent' });
      return;
    }

    // Cooldown: do not send another OTP within 60 seconds
    const latestOtp = await prisma.passwordResetOtp.findFirst({
      where: {
        phone: normalizedPhone,
        createdAt: { gt: new Date(Date.now() - 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (latestOtp) {
      res.json({ message: 'If the account exists, an OTP has been sent' });
      return;
    }

    // Invalidate previous active OTPs
    await prisma.passwordResetOtp.updateMany({
      where: {
        phone: normalizedPhone,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    if (!customer.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    await prisma.passwordResetOtp.create({
      data: {
        customerId_uuid: customer.id_uuid,
        phone: normalizedPhone,
        codeHash,
        expiresAt,
      },
    });

    await sendSMS({
      to: normalizedPhone,
      message: `Your AIDOO TECH password reset code is ${code}. It expires in 10 minutes.`,
    });

    res.json({ message: 'If the account exists, an OTP has been sent' });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ error: 'Failed to request password reset' });
  }
}

// Reset password using OTP
export async function resetCustomerPasswordWithOtp(req: Request, res: Response): Promise<void> {
  try {
    const { phone, code, newPassword } = req.body;

    if (!phone || !code || !newPassword) {
      res.status(400).json({ error: 'Phone number, code, and new password are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    const normalizedPhone = sanitizePhoneNumber(phone);
    if (!validatePhoneNumber(normalizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number format' });
      return;
    }

    const otp = await prisma.passwordResetOtp.findFirst({
      where: {
        phone: normalizedPhone,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    if (otp.attempts >= 5) {
      await prisma.passwordResetOtp.update({
        where: { id: otp.id },
        data: { usedAt: new Date() },
      });
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    const isValid = await bcrypt.compare(String(code), otp.codeHash);
    if (!isValid) {
      await prisma.passwordResetOtp.update({
        where: { id: otp.id },
        data: { attempts: otp.attempts + 1 },
      });
      res.status(400).json({ error: 'Invalid or expired code' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction([
      prisma.customer.update({
        where: { id_uuid: otp.customerId_uuid },
        data: { password: hashedPassword },
      }),
      prisma.passwordResetOtp.update({
        where: { id: otp.id },
        data: { usedAt: new Date() },
      }),
    ]);

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
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
    const customerLookup = (req.user as CustomerPayload).legacyId
      ? { id_uuid: req.user!.id }
      : { id: req.user!.id };

    const customer = await prisma.customer.findFirst({
      where: customerLookup,
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
      id: customer.id_uuid || customer.id,
      legacyId: customer.id,
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

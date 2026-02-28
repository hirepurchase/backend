import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { sendWelcomeNotification } from '../services/notificationService';
import { AuthenticatedRequest, CustomerPayload } from '../types';
import { generateMembershipId, sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';
import { uploadToSupabase, deleteFromSupabase } from '../services/storageService';

// Create customer (Admin only)
export async function createCustomer(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { firstName, lastName, phone, email, address, nationalId, dateOfBirth } = req.body;

    if (!firstName || !lastName || !phone) {
      res.status(400).json({ error: 'First name, last name, and phone are required' });
      return;
    }

    const normalizedPhone = sanitizePhoneNumber(phone);
    if (!validatePhoneNumber(normalizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number format' });
      return;
    }

    // Check if phone already exists
    const existingPhone = await prisma.customer.findFirst({ where: { phone: normalizedPhone } });
    if (existingPhone) {
      res.status(400).json({ error: 'Phone number already registered' });
      return;
    }

    // Check if email already exists
    if (email) {
      const existingEmail = await prisma.customer.findUnique({ where: { email } });
      if (existingEmail) {
        res.status(400).json({ error: 'Email already registered' });
        return;
      }
    }

    // Generate unique membership ID
    let membershipId = generateMembershipId();

    // Ensure uniqueness
    let exists = await prisma.customer.findUnique({ where: { membershipId } });
    while (exists) {
      membershipId = generateMembershipId();
      exists = await prisma.customer.findUnique({ where: { membershipId } });
    }

    // Handle photo upload
    let photoUrl: string | null = null;
    if (req.file) {
      // Upload to Supabase Storage
      const uploadResult = await uploadToSupabase(
        req.file.buffer,
        'customers',
        req.file.originalname
      );

      if (uploadResult.success && uploadResult.publicUrl) {
        photoUrl = uploadResult.publicUrl;
      } else {
        console.error('Photo upload failed:', uploadResult.error);
        res.status(500).json({ error: 'Failed to upload customer photo' });
        return;
      }
    }

    const customer = await prisma.customer.create({
      data: {
        id_uuid: randomUUID(),
        membershipId,
        firstName: firstName.toUpperCase(),
        lastName: lastName.toUpperCase(),
        phone: normalizedPhone,
        email: email || null,
        address,
        nationalId,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        photoUrl,
        createdById: req.user!.id,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_CUSTOMER',
      entity: 'Customer',
      entityId: customer.id,
      newValues: { membershipId, firstName, lastName, phone, email },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Send welcome notification (non-blocking)
    sendWelcomeNotification({
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email || undefined,
      phone: customer.phone,
      membershipId: customer.membershipId,
      customerId: customer.id_uuid || customer.id,
    }).catch(error => {
      console.error('Failed to send welcome notification:', error);
    });

    res.status(201).json({
      id: customer.id_uuid || customer.id,
      legacyId: customer.id,
      membershipId: customer.membershipId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      nationalId: customer.nationalId,
      dateOfBirth: customer.dateOfBirth,
      photoUrl: customer.photoUrl,
      isActivated: customer.isActivated,
      createdAt: customer.createdAt,
    });
  } catch (error) {
    console.error('Create customer error:', error);
    res.status(500).json({ error: 'Failed to create customer' });
  }
}

// Get all customers (Admin)
export async function getAllCustomers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      isActivated,
    } = req.query;

    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { membershipId: { contains: search as string, mode: 'insensitive' } },
        { firstName: { contains: search as string, mode: 'insensitive' } },
        { lastName: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    if (isActivated !== undefined) {
      where.isActivated = isActivated === 'true';
    }

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: {
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
          _count: {
            select: {
              contracts: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({
      customers: customers.map(c => ({
        id: c.id,
        membershipId: c.membershipId,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        phone: c.phone,
        address: c.address,
        nationalId: c.nationalId,
        photoUrl: c.photoUrl,
        isActivated: c.isActivated,
        activatedAt: c.activatedAt,
        createdBy: c.createdBy,
        contractsCount: c._count.contracts,
        createdAt: c.createdAt,
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}

// Get customer by ID (Admin)
export async function getCustomerById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id_uuid: id },
      include: {
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        contracts: {
          include: {
            inventoryItem: {
              include: {
                product: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    res.json({
      ...customer,
      id: customer.id_uuid || customer.id,
      legacyId: customer.id,
    });
  } catch (error) {
    console.error('Get customer error:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
}

// Get customer by membership ID (Admin)
export async function getCustomerByMembershipId(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { membershipId } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { membershipId },
      include: {
        contracts: {
          where: { status: 'ACTIVE' },
          include: {
            inventoryItem: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    res.json({
      id: customer.id_uuid || customer.id,
      legacyId: customer.id,
      membershipId: customer.membershipId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      isActivated: customer.isActivated,
      activeContracts: customer.contracts.length,
    });
  } catch (error) {
    console.error('Get customer by membership ID error:', error);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
}

// Update customer (Admin)
export async function updateCustomer(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone, address, nationalId, dateOfBirth } = req.body;

    const existingCustomer = await prisma.customer.findUnique({ where: { id } });

    if (!existingCustomer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (firstName) updateData.firstName = firstName.toUpperCase();
    if (lastName) updateData.lastName = lastName.toUpperCase();
    if (phone) {
      const normalizedPhone = sanitizePhoneNumber(phone);
      if (!validatePhoneNumber(normalizedPhone)) {
        res.status(400).json({ error: 'Invalid phone number format' });
        return;
      }
      const existingPhone = await prisma.customer.findFirst({
        where: { phone: normalizedPhone, NOT: { id } },
      });
      if (existingPhone) {
        res.status(400).json({ error: 'Phone number already registered' });
        return;
      }
      updateData.phone = normalizedPhone;
    }
    if (address !== undefined) updateData.address = address;
    if (nationalId !== undefined) updateData.nationalId = nationalId;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;

    // Handle photo upload if file is provided
    if (req.file) {
      const uploadResult = await uploadToSupabase(
        req.file.buffer,
        'customer-photos',
        req.file.originalname
      );

      if (uploadResult.success && uploadResult.publicUrl) {
        // Delete old photo if it exists
        if (existingCustomer.photoUrl) {
          await deleteFromSupabase(existingCustomer.photoUrl);
        }
        updateData.photoUrl = uploadResult.publicUrl;
      } else {
        console.error('Photo upload failed:', uploadResult.error);
        res.status(500).json({ error: 'Failed to upload customer photo' });
        return;
      }
    }

    const updatedCustomer = await prisma.customer.update({
      where: { id },
      data: updateData,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_CUSTOMER',
      entity: 'Customer',
      entityId: id,
      oldValues: {
        firstName: existingCustomer.firstName,
        lastName: existingCustomer.lastName,
        phone: existingCustomer.phone,
        address: existingCustomer.address,
        photoUrl: existingCustomer.photoUrl,
      },
      newValues: updateData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(updatedCustomer);
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
}

// Customer updates own profile
export async function updateOwnProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = (req.user as CustomerPayload).legacyId || req.user!.id;
    const { email, phone, address } = req.body;

    const existingCustomer = await prisma.customer.findUnique({ where: { id: customerId } });

    if (!existingCustomer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Check if email is being changed and if it's already in use
    if (email && email !== existingCustomer.email) {
      const existingEmail = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
      if (existingEmail && existingEmail.id !== customerId) {
        res.status(400).json({ error: 'Email is already in use' });
        return;
      }
    }

    const updateData: Record<string, unknown> = {};
    if (email !== undefined) updateData.email = email ? email.toLowerCase() : null;
    if (phone) {
      const normalizedPhone = sanitizePhoneNumber(phone);
      if (!validatePhoneNumber(normalizedPhone)) {
        res.status(400).json({ error: 'Invalid phone number format' });
        return;
      }
      const existingPhone = await prisma.customer.findFirst({
        where: { phone: normalizedPhone, NOT: { id: customerId } },
      });
      if (existingPhone) {
        res.status(400).json({ error: 'Phone number already registered' });
        return;
      }
      updateData.phone = normalizedPhone;
    }
    if (address !== undefined) updateData.address = address;

    const updatedCustomer = await prisma.customer.update({
      where: { id: customerId },
      data: updateData,
    });

    await createAuditLog({
      action: 'UPDATE_OWN_PROFILE',
      entity: 'Customer',
      entityId: customerId,
      oldValues: {
        email: existingCustomer.email,
        phone: existingCustomer.phone,
        address: existingCustomer.address,
      },
      newValues: updateData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      id: updatedCustomer.id,
      membershipId: updatedCustomer.membershipId,
      email: updatedCustomer.email,
      firstName: updatedCustomer.firstName,
      lastName: updatedCustomer.lastName,
      phone: updatedCustomer.phone,
      address: updatedCustomer.address,
      dateOfBirth: updatedCustomer.dateOfBirth,
    });
  } catch (error) {
    console.error('Update own profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

// Customer changes own password
export async function changeCustomerPassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = (req.user as CustomerPayload).legacyId || req.user!.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new passwords are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    const customer = await prisma.customer.findUnique({ where: { id: customerId } });

    if (!customer || !customer.password) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const isValidPassword = await bcrypt.compare(currentPassword, customer.password);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.customer.update({
      where: { id: customerId },
      data: { password: hashedPassword },
    });

    await createAuditLog({
      action: 'CHANGE_PASSWORD',
      entity: 'Customer',
      entityId: customerId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change customer password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
}

// Delete customer (Admin only - only if no contracts)
export async function deleteCustomer(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        _count: {
          select: { contracts: true },
        },
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Check if customer has any contracts
    if (customer._count.contracts > 0) {
      res.status(400).json({
        error: 'Cannot delete customer with existing contracts',
        contractsCount: customer._count.contracts,
      });
      return;
    }

    // Delete customer photo from Supabase if it exists
    if (customer.photoUrl) {
      await deleteFromSupabase(customer.photoUrl);
    }

    // Delete the customer
    await prisma.customer.delete({ where: { id } });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_CUSTOMER',
      entity: 'Customer',
      entityId: id,
      oldValues: {
        membershipId: customer.membershipId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
}

// Customer gets own profile
export async function getOwnProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = (req.user as CustomerPayload).legacyId || req.user!.id;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        id_uuid: true,
        membershipId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        address: true,
        nationalId: true,
        dateOfBirth: true,
        createdAt: true,
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    res.json(customer);
  } catch (error) {
    console.error('Get own profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
}

// Get customer's payments
export async function getCustomerPayments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = req.user!.id;

    const payments = await prisma.paymentTransaction.findMany({
      where: {
        customerId_uuid: customerId,
      },
      include: {
        contract: {
          select: {
            contractNumber: true,
            inventoryItem: {
              select: {
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({ payments });
  } catch (error) {
    console.error('Get customer payments error:', error);
    res.status(500).json({ error: 'Failed to get payments' });
  }
}

// Get customer's upcoming installments
export async function getCustomerUpcomingInstallments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = req.user!.id;

    const upcomingInstallments = await prisma.installmentSchedule.findMany({
      where: {
        contract: {
          customerId_uuid: customerId,
          status: 'ACTIVE',
        },
        status: {
          in: ['PENDING', 'OVERDUE'],
        },
      },
      include: {
        contract: {
          select: {
            contractNumber: true,
            inventoryItem: {
              select: {
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        dueDate: 'asc',
      },
      take: 10,
    });

    res.json({ installments: upcomingInstallments });
  } catch (error) {
    console.error('Get customer upcoming installments error:', error);
    res.status(500).json({ error: 'Failed to get upcoming installments' });
  }
}

// Get customer statement (Admin only)
export async function getCustomerStatement(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    // Get customer details
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Get all contracts
    const contracts = await prisma.hirePurchaseContract.findMany({
      where: { customerId_uuid: id },
      include: {
        inventoryItem: {
          include: {
            product: true,
          },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        penalties: {
          where: { isPaid: false },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate summary
    let totalContractValue = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let totalOverdue = 0;
    let totalPenalties = 0;

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    contracts.forEach((contract) => {
      totalContractValue += contract.totalPrice;
      totalPaid += contract.totalPaid;
      totalOutstanding += contract.outstandingBalance;

      // Calculate overdue amount
      contract.installments.forEach((installment) => {
        if ((installment.status === 'OVERDUE' || installment.status === 'PARTIAL') && installment.dueDate < now) {
          totalOverdue += installment.amount - installment.paidAmount;
        }
      });

      // Calculate penalties
      contract.penalties.forEach((penalty) => {
        totalPenalties += penalty.amount;
      });
    });

    // Get payment history
    const paymentHistory = await prisma.paymentTransaction.findMany({
      where: { customerId_uuid: id },
      include: {
        contract: {
          select: {
            contractNumber: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Calculate account status
    let accountStatus = 'GOOD_STANDING';
    if (totalOverdue > 0) {
      accountStatus = 'OVERDUE';
    } else if (contracts.some(c => c.status === 'DEFAULTED')) {
      accountStatus = 'DEFAULTED';
    } else if (contracts.every(c => c.status === 'COMPLETED')) {
      accountStatus = 'COMPLETED';
    }

    res.json({
      customer: {
        id: customer.id_uuid || customer.id,
        legacyId: customer.id,
        membershipId: customer.membershipId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
        nationalId: customer.nationalId,
        dateOfBirth: customer.dateOfBirth,
        photoUrl: customer.photoUrl,
        isActivated: customer.isActivated,
        activatedAt: customer.activatedAt,
        createdAt: customer.createdAt,
        createdBy: customer.createdBy,
      },
      summary: {
        totalContractValue,
        totalPaid,
        totalOutstanding,
        totalOverdue,
        totalPenalties,
        accountStatus,
        activeContracts: contracts.filter(c => c.status === 'ACTIVE').length,
        completedContracts: contracts.filter(c => c.status === 'COMPLETED').length,
        totalContracts: contracts.length,
      },
      contracts,
      paymentHistory,
    });
  } catch (error) {
    console.error('Get customer statement error:', error);
    res.status(500).json({ error: 'Failed to generate customer statement' });
  }
}

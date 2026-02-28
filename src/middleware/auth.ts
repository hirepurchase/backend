import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest, AdminUserPayload, CustomerPayload } from '../types';
import prisma from '../config/database';

export type { AuthenticatedRequest } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';

export function generateToken(payload: AdminUserPayload | CustomerPayload, userType: 'admin' | 'customer'): string {
  return jwt.sign(
    { ...payload, userType },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export function verifyToken(token: string): { payload: AdminUserPayload | CustomerPayload; userType: 'admin' | 'customer' } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as (AdminUserPayload | CustomerPayload) & { userType: 'admin' | 'customer' };
    const { userType, ...payload } = decoded;
    return { payload, userType };
  } catch {
    return null;
  }
}

export async function authenticateAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const verified = verifyToken(token);

    if (!verified || verified.userType !== 'admin') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const adminPayload = verified.payload as AdminUserPayload;

    // Verify admin still exists and is active
    const admin = await prisma.adminUser.findUnique({
      where: { id: adminPayload.id },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
      },
    });

    if (!admin || !admin.isActive) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    req.user = {
      id: admin.id,
      email: admin.email,
      role: admin.role.name,
      permissions: admin.role.permissions.map(p => p.name),
    };
    req.userType = 'admin';

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function authenticateCustomer(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const verified = verifyToken(token);

    if (!verified || verified.userType !== 'customer') {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const customerPayload = verified.payload as CustomerPayload;

    const where = customerPayload.legacyId
      ? { id_uuid: customerPayload.id }
      : { id: customerPayload.id };

    // Verify customer still exists and is activated
    const customer = await prisma.customer.findFirst({
      where,
    });

    if (!customer || !customer.isActivated) {
      res.status(401).json({ error: 'Customer not found or not activated' });
      return;
    }

    req.user = {
      id: customer.id_uuid || customer.id,
      legacyId: customer.id,
      membershipId: customer.membershipId,
      email: customer.email,
    };
    req.userType = 'customer';

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function authenticateAny(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Access token required' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const verified = verifyToken(token);

    if (!verified) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (verified.userType === 'admin') {
      const adminPayload = verified.payload as AdminUserPayload;
      const admin = await prisma.adminUser.findUnique({
        where: { id: adminPayload.id },
        include: {
          role: {
            include: {
              permissions: true,
            },
          },
        },
      });

      if (!admin || !admin.isActive) {
        res.status(401).json({ error: 'User not found or inactive' });
        return;
      }

      req.user = {
        id: admin.id,
        email: admin.email,
        role: admin.role.name,
        permissions: admin.role.permissions.map(p => p.name),
      };
      req.userType = 'admin';
    } else {
      const customerPayload = verified.payload as CustomerPayload;
      const where = customerPayload.legacyId
        ? { id_uuid: customerPayload.id }
        : { id: customerPayload.id };
      const customer = await prisma.customer.findFirst({
        where,
      });

      if (!customer || !customer.isActivated) {
        res.status(401).json({ error: 'Customer not found or not activated' });
        return;
      }

      req.user = {
        id: customer.id_uuid || customer.id,
        legacyId: customer.id,
        membershipId: customer.membershipId,
        email: customer.email,
      };
      req.userType = 'customer';
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export function requirePermission(...permissions: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (req.userType !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const adminUser = req.user as AdminUserPayload;

    // Super admin bypasses permission checks
    if (adminUser.role === 'SUPER_ADMIN') {
      next();
      return;
    }

    const hasPermission = permissions.some(permission =>
      adminUser.permissions.includes(permission)
    );

    if (!hasPermission) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

export function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.userType !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  const adminUser = req.user as AdminUserPayload;

  if (adminUser.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }

  next();
}

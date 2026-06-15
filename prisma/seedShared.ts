import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  PERMISSIONS,
  PERMISSION_DEFINITIONS,
} from '../src/constants/permissions';

type SeedRoles = {
  superAdminRole: { id: string; name: string };
  adminRole: { id: string; name: string };
  salesRole: { id: string; name: string };
  agentRole: { id: string; name: string };
};

type SeedCatalog = {
  categories: {
    mobilePhonesId: string;
    televisionsId: string;
    laptopsId: string;
    homeAppliancesId: string;
    furnitureId: string;
  };
  products: {
    iphoneId: string;
    samsungId: string;
    tvId: string;
  };
};

export async function seedPermissionsAndRoles(prisma: PrismaClient): Promise<SeedRoles> {
  for (const perm of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: { description: perm.description },
      create: { name: perm.name, description: perm.description },
    });
  }

  const allPermissions = await prisma.permission.findMany();

  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Super Administrator with full access',
      isSystem: true,
      permissions: {
        connect: allPermissions.map((permission) => ({ id: permission.id })),
      },
    },
    select: { id: true, name: true },
  });

  const adminPermissionExclusions = new Set<string>([
    PERMISSIONS.MANAGE_USERS,
    PERMISSIONS.MANAGE_ROLES,
    PERMISSIONS.MANAGE_PERMISSIONS,
    PERMISSIONS.MANAGE_HUBTEL_PAYMENTS,
    PERMISSIONS.DELETE_INVENTORY,
  ]);

  const adminPermissions = allPermissions
    .filter((permission) => !adminPermissionExclusions.has(String(permission.name)))
    .map((permission) => ({ id: permission.id }));

  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {
      permissions: {
        set: adminPermissions,
      },
    },
    create: {
      name: 'ADMIN',
      description: 'Administrator with operational access',
      isSystem: true,
      permissions: {
        connect: adminPermissions,
      },
    },
    select: { id: true, name: true },
  });

  const salesPermissionNames = new Set<string>([
    PERMISSIONS.CREATE_CUSTOMER,
    PERMISSIONS.VIEW_OWN_CUSTOMERS,
    PERMISSIONS.UPDATE_CUSTOMER,
    PERMISSIONS.CREATE_CONTRACT,
    PERMISSIONS.VIEW_OWN_CONTRACTS,
    PERMISSIONS.RECORD_PAYMENT,
    PERMISSIONS.VIEW_PAYMENTS,
    PERMISSIONS.VIEW_FAILED_PAYMENTS,
    PERMISSIONS.VIEW_DASHBOARD,
  ]);

  const salesPermissions = allPermissions
    .filter((permission) => salesPermissionNames.has(String(permission.name)))
    .map((permission) => ({ id: permission.id }));

  const salesRole = await prisma.role.upsert({
    where: { name: 'SALES_AGENT' },
    update: {
      permissions: {
        set: salesPermissions,
      },
    },
    create: {
      name: 'SALES_AGENT',
      description: 'Sales agent with customer and contract management',
      isSystem: true,
      permissions: {
        connect: salesPermissions,
      },
    },
    select: { id: true, name: true },
  });

  const agentPermissionNames = new Set<string>([
    PERMISSIONS.CREATE_CUSTOMER,
    PERMISSIONS.VIEW_OWN_CUSTOMERS,
    PERMISSIONS.UPDATE_CUSTOMER,
    PERMISSIONS.CREATE_CONTRACT,
    PERMISSIONS.VIEW_OWN_CONTRACTS,
    PERMISSIONS.RECORD_PAYMENT,
    PERMISSIONS.VIEW_AGENT_COMMISSIONS,
    PERMISSIONS.PAY_AGENT_DEPOSIT,
    PERMISSIONS.VIEW_DAILY_PAYMENTS,
    PERMISSIONS.MANAGE_INVENTORY,
  ]);

  const agentPermissions = allPermissions
    .filter((permission) => agentPermissionNames.has(String(permission.name)))
    .map((permission) => ({ id: permission.id }));

  const agentRole = await prisma.role.upsert({
    where: { name: 'AGENT' },
    update: {
      permissions: {
        set: agentPermissions,
      },
    },
    create: {
      name: 'AGENT',
      description: 'Field agent who registers customers, adds inventory and creates contracts (requires approval)',
      isSystem: true,
      permissions: {
        connect: agentPermissions,
      },
    },
    select: { id: true, name: true },
  });

  return {
    superAdminRole,
    adminRole,
    salesRole,
    agentRole,
  };
}

export async function seedDefaultAdminUsers(
  prisma: PrismaClient,
  roles: SeedRoles,
  defaultPassword: string = 'admin123'
): Promise<void> {
  const hashedPassword = await bcrypt.hash(defaultPassword, 12);

  await prisma.adminUser.upsert({
    where: { email: 'admin@hirepurchase.com' },
    update: {
      firstName: 'Super',
      lastName: 'Admin',
      phone: '0200000000',
      roleId: roles.superAdminRole.id,
      isActive: true,
    },
    create: {
      email: 'admin@hirepurchase.com',
      password: hashedPassword,
      firstName: 'Super',
      lastName: 'Admin',
      phone: '0200000000',
      roleId: roles.superAdminRole.id,
    },
  });

  await prisma.adminUser.upsert({
    where: { email: 'sales@hirepurchase.com' },
    update: {
      firstName: 'Sales',
      lastName: 'Admin',
      phone: '0200000001',
      roleId: roles.adminRole.id,
      isActive: true,
    },
    create: {
      email: 'sales@hirepurchase.com',
      password: hashedPassword,
      firstName: 'Sales',
      lastName: 'Admin',
      phone: '0200000001',
      roleId: roles.adminRole.id,
    },
  });
}

export async function seedBaseCatalog(prisma: PrismaClient): Promise<SeedCatalog> {
  const categories = [
    { name: 'Mobile Phones', description: 'Smartphones and feature phones' },
    { name: 'Televisions', description: 'Smart TVs and LED TVs' },
    { name: 'Laptops', description: 'Laptops and notebooks' },
    { name: 'Home Appliances', description: 'Refrigerators, washing machines, etc.' },
    { name: 'Furniture', description: 'Home and office furniture' },
  ];

  for (const category of categories) {
    await prisma.productCategory.upsert({
      where: { name: category.name },
      update: {},
      create: category,
    });
  }

  const [
    mobilePhones,
    televisions,
    laptops,
    homeAppliances,
    furniture,
  ] = await Promise.all([
    prisma.productCategory.findUniqueOrThrow({ where: { name: 'Mobile Phones' } }),
    prisma.productCategory.findUniqueOrThrow({ where: { name: 'Televisions' } }),
    prisma.productCategory.findUniqueOrThrow({ where: { name: 'Laptops' } }),
    prisma.productCategory.findUniqueOrThrow({ where: { name: 'Home Appliances' } }),
    prisma.productCategory.findUniqueOrThrow({ where: { name: 'Furniture' } }),
  ]);

  const iphone = await prisma.product.upsert({
    where: { id: 'sample-iphone' },
    update: {
      name: 'iPhone 15 Pro',
      description: '256GB, Titanium',
      basePrice: 8500,
      categoryId: mobilePhones.id,
      isActive: true,
    },
    create: {
      id: 'sample-iphone',
      name: 'iPhone 15 Pro',
      description: '256GB, Titanium',
      basePrice: 8500,
      categoryId: mobilePhones.id,
    },
  });

  const samsung = await prisma.product.upsert({
    where: { id: 'sample-samsung' },
    update: {
      name: 'Samsung Galaxy S24',
      description: '256GB, Phantom Black',
      basePrice: 6500,
      categoryId: mobilePhones.id,
      isActive: true,
    },
    create: {
      id: 'sample-samsung',
      name: 'Samsung Galaxy S24',
      description: '256GB, Phantom Black',
      basePrice: 6500,
      categoryId: mobilePhones.id,
    },
  });

  const tv = await prisma.product.upsert({
    where: { id: 'sample-tv' },
    update: {
      name: 'LG 55" Smart TV',
      description: 'OLED, 4K UHD',
      basePrice: 4500,
      categoryId: televisions.id,
      isActive: true,
    },
    create: {
      id: 'sample-tv',
      name: 'LG 55" Smart TV',
      description: 'OLED, 4K UHD',
      basePrice: 4500,
      categoryId: televisions.id,
    },
  });

  const inventorySeeds = [
    { productId: iphone.id, serialNumber: 'IMEI001234567890' },
    { productId: iphone.id, serialNumber: 'IMEI001234567891' },
    { productId: iphone.id, serialNumber: 'IMEI001234567892' },
    { productId: samsung.id, serialNumber: 'IMEI002345678901' },
    { productId: samsung.id, serialNumber: 'IMEI002345678902' },
    { productId: tv.id, serialNumber: 'TV55LG001' },
    { productId: tv.id, serialNumber: 'TV55LG002' },
  ];

  for (const item of inventorySeeds) {
    await prisma.inventoryItem.upsert({
      where: { serialNumber: item.serialNumber },
      update: {
        productId: item.productId,
      },
      create: {
        productId: item.productId,
        serialNumber: item.serialNumber,
        status: 'AVAILABLE',
      },
    });
  }

  return {
    categories: {
      mobilePhonesId: mobilePhones.id,
      televisionsId: televisions.id,
      laptopsId: laptops.id,
      homeAppliancesId: homeAppliances.id,
      furnitureId: furniture.id,
    },
    products: {
      iphoneId: iphone.id,
      samsungId: samsung.id,
      tvId: tv.id,
    },
  };
}

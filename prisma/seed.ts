import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  PERMISSIONS,
  PERMISSION_DEFINITIONS,
} from '../src/constants/permissions';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create permissions
  for (const perm of PERMISSION_DEFINITIONS) {
    await prisma.permission.upsert({
      where: { name: perm.name },
      update: { description: perm.description },
      create: { name: perm.name, description: perm.description },
    });
  }

  console.log('Permissions created');

  // Get all permissions
  const allPermissions = await prisma.permission.findMany();

  // Create roles
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Super Administrator with full access',
      isSystem: true,
      permissions: {
        connect: allPermissions.map(p => ({ id: p.id })),
      },
    },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {
      permissions: {
        set: allPermissions
          .filter(p => ![
            PERMISSIONS.MANAGE_USERS,
            PERMISSIONS.MANAGE_ROLES,
            PERMISSIONS.MANAGE_PERMISSIONS,
            PERMISSIONS.MANAGE_HUBTEL_PAYMENTS,
            PERMISSIONS.DELETE_INVENTORY,
          ].includes(p.name as typeof PERMISSIONS[keyof typeof PERMISSIONS]))
          .map(p => ({ id: p.id })),
      },
    },
    create: {
      name: 'ADMIN',
      description: 'Administrator with operational access',
      isSystem: true,
      permissions: {
        connect: allPermissions
          .filter(p => ![
            PERMISSIONS.MANAGE_USERS,
            PERMISSIONS.MANAGE_ROLES,
            PERMISSIONS.MANAGE_PERMISSIONS,
            PERMISSIONS.MANAGE_HUBTEL_PAYMENTS,
            PERMISSIONS.DELETE_INVENTORY,
          ].includes(p.name as typeof PERMISSIONS[keyof typeof PERMISSIONS]))
          .map(p => ({ id: p.id })),
      },
    },
  });

  const salesRole = await prisma.role.upsert({
    where: { name: 'SALES_AGENT' },
    update: {
      permissions: {
        set: allPermissions
          .filter(p => [
            PERMISSIONS.CREATE_CUSTOMER,
            PERMISSIONS.VIEW_OWN_CUSTOMERS,
            PERMISSIONS.UPDATE_CUSTOMER,
            PERMISSIONS.CREATE_CONTRACT,
            PERMISSIONS.VIEW_OWN_CONTRACTS,
            PERMISSIONS.RECORD_PAYMENT,
            PERMISSIONS.VIEW_PAYMENTS,
            PERMISSIONS.VIEW_FAILED_PAYMENTS,
            PERMISSIONS.VIEW_DASHBOARD,
          ].includes(p.name))
          .map(p => ({ id: p.id })),
      },
    },
    create: {
      name: 'SALES_AGENT',
      description: 'Sales agent with customer and contract management',
      isSystem: true,
      permissions: {
        connect: allPermissions
          .filter(p => [
            PERMISSIONS.CREATE_CUSTOMER,
            PERMISSIONS.VIEW_OWN_CUSTOMERS,
            PERMISSIONS.UPDATE_CUSTOMER,
            PERMISSIONS.CREATE_CONTRACT,
            PERMISSIONS.VIEW_OWN_CONTRACTS,
            PERMISSIONS.RECORD_PAYMENT,
            PERMISSIONS.VIEW_PAYMENTS,
            PERMISSIONS.VIEW_FAILED_PAYMENTS,
            PERMISSIONS.VIEW_DASHBOARD,
          ].includes(p.name))
          .map(p => ({ id: p.id })),
      },
    },
  });

  // AGENT role: can create customers, add inventory, create contracts (goes to approval)
  await prisma.role.upsert({
    where: { name: 'AGENT' },
    update: {
      permissions: {
        set: allPermissions
          .filter(p => [
            PERMISSIONS.CREATE_CUSTOMER,
            PERMISSIONS.VIEW_OWN_CUSTOMERS,
            PERMISSIONS.UPDATE_CUSTOMER,
            PERMISSIONS.MANAGE_INVENTORY,
            PERMISSIONS.EDIT_INVENTORY,
            PERMISSIONS.CREATE_CONTRACT,
            PERMISSIONS.VIEW_OWN_CONTRACTS,
            PERMISSIONS.RECORD_PAYMENT,
            PERMISSIONS.VIEW_PAYMENTS,
            PERMISSIONS.VIEW_DASHBOARD,
          ].includes(p.name))
          .map(p => ({ id: p.id })),
      },
    },
    create: {
      name: 'AGENT',
      description: 'Field agent who registers customers, adds inventory and creates contracts (requires approval)',
      isSystem: true,
      permissions: {
        connect: allPermissions
          .filter(p => [
            PERMISSIONS.CREATE_CUSTOMER,
            PERMISSIONS.VIEW_OWN_CUSTOMERS,
            PERMISSIONS.UPDATE_CUSTOMER,
            PERMISSIONS.MANAGE_INVENTORY,
            PERMISSIONS.EDIT_INVENTORY,
            PERMISSIONS.CREATE_CONTRACT,
            PERMISSIONS.VIEW_OWN_CONTRACTS,
            PERMISSIONS.RECORD_PAYMENT,
            PERMISSIONS.VIEW_PAYMENTS,
            PERMISSIONS.VIEW_DASHBOARD,
          ].includes(p.name))
          .map(p => ({ id: p.id })),
      },
    },
  });

  console.log('Roles created');

  // Create super admin user
  const hashedPassword = await bcrypt.hash('admin123', 12);

  await prisma.adminUser.upsert({
    where: { email: 'admin@hirepurchase.com' },
    update: {},
    create: {
      email: 'admin@hirepurchase.com',
      password: hashedPassword,
      firstName: 'Super',
      lastName: 'Admin',
      phone: '0200000000',
      roleId: superAdminRole.id,
    },
  });

  // Create regular admin user
  await prisma.adminUser.upsert({
    where: { email: 'sales@hirepurchase.com' },
    update: {},
    create: {
      email: 'sales@hirepurchase.com',
      password: hashedPassword,
      firstName: 'Sales',
      lastName: 'Admin',
      phone: '0200000001',
      roleId: adminRole.id,
    },
  });

  console.log('Admin users created');

  // Create sample product categories
  const categories = [
    { name: 'Mobile Phones', description: 'Smartphones and feature phones' },
    { name: 'Televisions', description: 'Smart TVs and LED TVs' },
    { name: 'Laptops', description: 'Laptops and notebooks' },
    { name: 'Home Appliances', description: 'Refrigerators, washing machines, etc.' },
    { name: 'Furniture', description: 'Home and office furniture' },
  ];

  for (const cat of categories) {
    await prisma.productCategory.upsert({
      where: { name: cat.name },
      update: {},
      create: cat,
    });
  }

  console.log('Product categories created');

  // Get categories
  const phonesCategory = await prisma.productCategory.findUnique({ where: { name: 'Mobile Phones' } });
  const tvCategory = await prisma.productCategory.findUnique({ where: { name: 'Televisions' } });

  // Create sample products
  if (phonesCategory) {
    const iphone = await prisma.product.upsert({
      where: { id: 'sample-iphone' },
      update: {},
      create: {
        id: 'sample-iphone',
        name: 'iPhone 15 Pro',
        description: '256GB, Titanium',
        basePrice: 8500,
        categoryId: phonesCategory.id,
      },
    });

    const samsung = await prisma.product.upsert({
      where: { id: 'sample-samsung' },
      update: {},
      create: {
        id: 'sample-samsung',
        name: 'Samsung Galaxy S24',
        description: '256GB, Phantom Black',
        basePrice: 6500,
        categoryId: phonesCategory.id,
      },
    });

    // Add sample inventory items
    const iphoneSerials = ['IMEI001234567890', 'IMEI001234567891', 'IMEI001234567892'];
    const samsungSerials = ['IMEI002345678901', 'IMEI002345678902'];

    for (const serial of iphoneSerials) {
      await prisma.inventoryItem.upsert({
        where: { serialNumber: serial },
        update: {},
        create: {
          productId: iphone.id,
          serialNumber: serial,
          status: 'AVAILABLE',
        },
      });
    }

    for (const serial of samsungSerials) {
      await prisma.inventoryItem.upsert({
        where: { serialNumber: serial },
        update: {},
        create: {
          productId: samsung.id,
          serialNumber: serial,
          status: 'AVAILABLE',
        },
      });
    }
  }

  if (tvCategory) {
    const tv = await prisma.product.upsert({
      where: { id: 'sample-tv' },
      update: {},
      create: {
        id: 'sample-tv',
        name: 'LG 55" Smart TV',
        description: 'OLED, 4K UHD',
        basePrice: 4500,
        categoryId: tvCategory.id,
      },
    });

    const tvSerials = ['TV55LG001', 'TV55LG002'];
    for (const serial of tvSerials) {
      await prisma.inventoryItem.upsert({
        where: { serialNumber: serial },
        update: {},
        create: {
          productId: tv.id,
          serialNumber: serial,
          status: 'AVAILABLE',
        },
      });
    }
  }

  console.log('Sample products and inventory created');
  console.log('Database seeding completed!');
  console.log('\nDefault admin credentials:');
  console.log('Email: admin@hirepurchase.com');
  console.log('Password: admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

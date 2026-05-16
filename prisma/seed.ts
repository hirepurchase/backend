import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  seedBaseCatalog,
  seedDefaultAdminUsers,
  seedPermissionsAndRoles,
} from './seedShared';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const roles = await seedPermissionsAndRoles(prisma);
  console.log('Permissions and roles created');

  await seedDefaultAdminUsers(prisma, roles);
  console.log('Admin users created');

  await seedBaseCatalog(prisma);
  console.log('Sample products and inventory created');

  console.log('Database seeding completed!');
  console.log('\nDefault admin credentials:');
  console.log('Email: admin@hirepurchase.com');
  console.log('Password: admin123');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

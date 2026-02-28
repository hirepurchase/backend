import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';

async function main() {
  const customers = await prisma.customer.findMany({
    where: { contracts: { some: {} } },
    select: { id: true, phone: true, isActivated: true, activatedAt: true },
  });

  let updated = 0;
  let skipped = 0;

  for (const customer of customers) {
    const normalizedPhone = sanitizePhoneNumber(customer.phone);
    if (!validatePhoneNumber(normalizedPhone)) {
      console.warn(`Skipping ${customer.id}: invalid phone ${customer.phone}`);
      skipped += 1;
      continue;
    }

    const hashedPassword = await bcrypt.hash(normalizedPhone, 12);

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        phone: normalizedPhone,
        password: hashedPassword,
        isActivated: true,
        activatedAt: customer.activatedAt || new Date(),
      },
    });
    updated += 1;
  }

  console.log(`Updated ${updated} customers. Skipped ${skipped}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

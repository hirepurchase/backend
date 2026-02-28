import prisma from '../config/database';
import { sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';

async function main() {
  const customers = await prisma.customer.findMany({
    select: { id: true, phone: true },
  });

  const invalid: { id: string; phone: string }[] = [];
  const toUpdate: { id: string; phone: string }[] = [];

  for (const customer of customers) {
    const normalized = sanitizePhoneNumber(customer.phone);
    if (!validatePhoneNumber(normalized)) {
      invalid.push({ id: customer.id, phone: customer.phone });
      continue;
    }
    if (normalized !== customer.phone) {
      toUpdate.push({ id: customer.id, phone: normalized });
    }
  }

  for (const row of toUpdate) {
    await prisma.customer.update({
      where: { id: row.id },
      data: { phone: row.phone },
    });
  }

  const normalizedMap = new Map<string, string[]>();
  const after = await prisma.customer.findMany({
    select: { id: true, phone: true },
  });

  for (const customer of after) {
    const normalized = sanitizePhoneNumber(customer.phone);
    const list = normalizedMap.get(normalized) || [];
    list.push(customer.id);
    normalizedMap.set(normalized, list);
  }

  const duplicates = Array.from(normalizedMap.entries()).filter(
    ([, ids]) => ids.length > 1
  );

  console.log(`Updated phones: ${toUpdate.length}`);
  console.log(`Invalid phones: ${invalid.length}`);
  if (invalid.length > 0) {
    console.log('Invalid phone records:');
    for (const row of invalid) {
      console.log(`- ${row.id}: ${row.phone}`);
    }
  }

  if (duplicates.length > 0) {
    console.log('Duplicate normalized phones found:');
    for (const [phone, ids] of duplicates) {
      console.log(`- ${phone}: ${ids.join(', ')}`);
    }
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

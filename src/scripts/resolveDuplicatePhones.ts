import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import prisma from '../config/database';
import { sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';

type CustomerRow = {
  id: string;
  phone: string;
  createdAt: Date;
  _count: {
    contracts: number;
    payments: number;
  };
};

function generateRandomPhone(existing: Set<string>): string {
  while (true) {
    const suffix = crypto.randomInt(0, 10_000_000).toString().padStart(7, '0');
    const candidate = `024${suffix}`;
    if (!existing.has(candidate) && validatePhoneNumber(candidate)) {
      existing.add(candidate);
      return candidate;
    }
  }
}

async function main() {
  const customers = await prisma.customer.findMany({
    select: {
      id: true,
      phone: true,
      createdAt: true,
      _count: {
        select: {
          contracts: true,
          payments: true,
        },
      },
    },
  });

  const existingPhones = new Set<string>(
    customers.map((c) => sanitizePhoneNumber(c.phone))
  );

  const groups = new Map<string, CustomerRow[]>();
  for (const customer of customers) {
    const normalized = sanitizePhoneNumber(customer.phone);
    if (!validatePhoneNumber(normalized)) {
      continue;
    }
    const list = groups.get(normalized) || [];
    list.push(customer);
    groups.set(normalized, list);
  }

  const changes: Array<{ id: string; oldPhone: string; newPhone: string }> = [];

  for (const [phone, list] of groups.entries()) {
    if (list.length <= 1) continue;

    const sorted = [...list].sort((a, b) => {
      if (b._count.contracts !== a._count.contracts) {
        return b._count.contracts - a._count.contracts;
      }
      if (b._count.payments !== a._count.payments) {
        return b._count.payments - a._count.payments;
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    const keep = sorted[0];
    const toChange = sorted.slice(1);

    for (const customer of toChange) {
      const newPhone = generateRandomPhone(existingPhones);
      await prisma.customer.update({
        where: { id: customer.id },
        data: { phone: newPhone },
      });
      changes.push({
        id: customer.id,
        oldPhone: phone,
        newPhone,
      });
    }
  }

  const logDir = path.join(__dirname, '..', '..', 'scripts', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'duplicate_phone_fixes.csv');
  const header = 'customer_id,old_phone,new_phone\n';
  const rows = changes.map((c) => `${c.id},${c.oldPhone},${c.newPhone}`).join('\n');
  fs.writeFileSync(logPath, header + rows + (rows ? '\n' : ''));

  console.log(`Updated ${changes.length} duplicate customers.`);
  console.log(`Log written to ${logPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

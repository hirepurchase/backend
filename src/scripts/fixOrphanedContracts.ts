import prisma from '../config/database';

// Map of contractNumber -> customer name (first, last)
const contractCustomerMap: Record<string, { firstName: string; lastName: string }> = {
  CON2602ZK9AYJ: { firstName: 'EMMANUEL', lastName: 'OSABOUTEY' },
  CON2602Z8J4H0: { firstName: 'KINGSLEY', lastName: 'ARYEETEY' },
  CON2602P8NHNF: { firstName: 'OBOAMA',   lastName: 'ERIC' },
  CON2602NPP42M: { firstName: 'KARIM',    lastName: 'ABDUL' },
  CON2602QLQHA3: { firstName: 'KWASI',    lastName: 'NYARKO' },
  CON2602AG1VAJ: { firstName: 'GODWIN',   lastName: 'MODZAKA' },
  CON2602VSBSE0: { firstName: 'KELVIN',   lastName: 'AKONNOR' },
  CON2602UYCR6D: { firstName: 'RICHARD',  lastName: 'AWAHA' },
};

async function main() {
  console.log('=== Fixing Orphaned Contracts ===\n');

  let fixed = 0;
  let failed = 0;

  for (const [contractNumber, { firstName, lastName }] of Object.entries(contractCustomerMap)) {
    // Find the customer by name (case-insensitive)
    const customers = await prisma.$queryRaw<{ id: string; id_uuid: string; firstName: string; lastName: string; phone: string; membershipId: string }[]>`
      SELECT id, id_uuid, "firstName", "lastName", phone, "membershipId"
      FROM "Customer"
      WHERE UPPER("firstName") = UPPER(${firstName})
        AND UPPER("lastName") = UPPER(${lastName})
    `;

    if (customers.length === 0) {
      console.error(`❌ [${contractNumber}] No customer found for ${firstName} ${lastName}`);
      failed++;
      continue;
    }

    if (customers.length > 1) {
      console.warn(`⚠️  [${contractNumber}] Multiple customers found for ${firstName} ${lastName}:`);
      customers.forEach(c => console.warn(`   - ${c.membershipId} | ${c.firstName} ${c.lastName} | ${c.phone}`));
      console.warn(`   Using first match: ${customers[0].membershipId}`);
    }

    const customer = customers[0];

    if (!customer.id_uuid) {
      console.error(`❌ [${contractNumber}] Customer ${customer.membershipId} has no id_uuid`);
      failed++;
      continue;
    }

    // Update the contract's customerId_uuid using raw SQL (Prisma ORM can't query NULL uuid rows)
    await prisma.$executeRaw`
      UPDATE "HirePurchaseContract"
      SET "customerId_uuid" = ${customer.id_uuid}::uuid
      WHERE "contractNumber" = ${contractNumber}
        AND "customerId_uuid" IS NULL
    `;

    console.log(`✅ [${contractNumber}] Linked to ${customer.firstName} ${customer.lastName} (${customer.membershipId}) — uuid: ${customer.id_uuid}`);
    fixed++;
  }

  console.log(`\n=== Done: ${fixed} fixed, ${failed} failed ===`);

  // Verify: show any still-orphaned contracts
  const remaining = await prisma.$queryRaw<{ contractNumber: string }[]>`
    SELECT "contractNumber" FROM "HirePurchaseContract" WHERE "customerId_uuid" IS NULL
  `;
  if (remaining.length > 0) {
    console.warn(`\n⚠️  Still orphaned: ${remaining.map(r => r.contractNumber).join(', ')}`);
  } else {
    console.log('\n✅ No orphaned contracts remain.');
  }
}

main()
  .catch((err) => {
    console.error('Script failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

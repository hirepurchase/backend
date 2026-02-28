import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function testAPI() {
  console.log('🔍 Simulating /contracts API call\n');

  // Get all active contracts with outstanding balance (same as frontend filter)
  const allContracts = await prisma.hirePurchaseContract.findMany({
    where: {
      status: 'ACTIVE',
      outstandingBalance: { gt: 0 }
    },
    include: {
      customer: {
        select: {
          id: true,
          membershipId: true,
          firstName: true,
          lastName: true,
          phone: true,
          isActivated: true,
        },
      },
      inventoryItem: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Total contracts with ACTIVE status and outstanding > 0: ${allContracts.length}\n`);

  // Find CON2512UJ6C0P
  const targetContract = allContracts.find(c => c.contractNumber === 'CON2512UJ6C0P');

  if (targetContract) {
    const index = allContracts.findIndex(c => c.contractNumber === 'CON2512UJ6C0P');
    console.log('✅ CON2512UJ6C0P FOUND in results!');
    console.log(`Position: #${index + 1} of ${allContracts.length}`);
    console.log(`Customer: ${targetContract.customer.firstName} ${targetContract.customer.lastName}`);
    console.log(`Customer Activated: ${targetContract.customer.isActivated ? 'Yes' : 'No'}`);
    console.log(`Outstanding: GHS ${targetContract.outstandingBalance.toFixed(2)}`);
    console.log('');
    console.log('If pagination is 10 items per page:');
    console.log(`  This contract is on page ${Math.ceil((index + 1) / 10)}`);
  } else {
    console.log('❌ CON2512UJ6C0P NOT FOUND in results!');
    console.log('Checking why...');

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { contractNumber: 'CON2512UJ6C0P' },
      include: { customer: true }
    });

    if (contract) {
      console.log('Contract exists but was filtered out:');
      console.log(`  Status: ${contract.status} (must be ACTIVE)`);
      console.log(`  Outstanding: ${contract.outstandingBalance} (must be > 0)`);
    }
  }

  console.log('\n📋 First 20 contracts in order:\n');
  allContracts.slice(0, 20).forEach((c, i) => {
    const activated = c.customer.isActivated ? '✅' : '❌';
    console.log(`${i + 1}. ${c.contractNumber} - ${c.customer.firstName} ${c.customer.lastName} ${activated}`);
  });

  await prisma.$disconnect();
}

testAPI();

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkCustomer() {
  const contractNumber = process.argv[2] || 'CON2512UJ6C0P';

  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { contractNumber },
    include: { customer: true }
  });

  if (!contract) {
    console.log('❌ Contract not found');
    await prisma.$disconnect();
    return;
  }

  console.log('\n📋 CONTRACT INFO');
  console.log('='.repeat(70));
  console.log('Contract Number:', contract.contractNumber);
  console.log('Contract Status:', contract.status);
  console.log('Created:', contract.createdAt.toLocaleString());

  console.log('\n👤 CUSTOMER INFO');
  console.log('='.repeat(70));
  console.log('Customer ID:', contract.customerId);
  console.log('Customer Name:', contract.customer.firstName, contract.customer.lastName);
  console.log('Membership ID:', contract.customer.membershipId);
  console.log('Email:', contract.customer.email || 'N/A');
  console.log('Phone:', contract.customer.phone);
  console.log('Is Activated:', contract.customer.isActivated ? '✅ YES' : '❌ NO');
  console.log('Has Password:', contract.customer.password ? '✅ YES' : '❌ NO');
  console.log('Activated At:', contract.customer.activatedAt ? contract.customer.activatedAt.toLocaleString() : 'Not activated');

  if (!contract.customer.isActivated) {
    console.log('\n⚠️  ISSUE IDENTIFIED:');
    console.log('='.repeat(70));
    console.log('❌ Customer account is NOT ACTIVATED!');
    console.log('');
    console.log('This is why the contract is not showing in the payments page.');
    console.log('The customer needs to:');
    console.log('  1. Activate their account via email/SMS link');
    console.log('  2. Set up their password');
    console.log('  3. Log in to see their contracts');
    console.log('');
    console.log('OR you can manually activate the account in the admin panel.');
  } else {
    console.log('\n✅ Customer account is activated.');
    console.log('Contract should be visible in payments page.');
  }

  await prisma.$disconnect();
}

checkCustomer();

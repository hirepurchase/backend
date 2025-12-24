import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function uppercaseCustomerNames() {
  console.log('🔄 Starting customer name uppercase conversion...');

  try {
    // Get all customers
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
      },
    });

    console.log(`📊 Found ${customers.length} customers to update`);

    let updatedCount = 0;

    // Update each customer
    for (const customer of customers) {
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          firstName: customer.firstName.toUpperCase(),
          lastName: customer.lastName.toUpperCase(),
        },
      });
      updatedCount++;
      if (updatedCount % 10 === 0) {
        console.log(`✅ Updated ${updatedCount}/${customers.length} customers`);
      }
    }

    console.log(`✅ Successfully converted ${updatedCount} customer names to uppercase`);
  } catch (error) {
    console.error('❌ Error converting customer names:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
uppercaseCustomerNames()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

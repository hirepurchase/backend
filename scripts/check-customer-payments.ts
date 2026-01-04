import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkCustomerPayments(customerName: string) {
  try {
    console.log(`\n========================================`);
    console.log(`Searching for customer: ${customerName}`);
    console.log(`========================================\n`);

    // Search for customer (case insensitive)
    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { firstName: { contains: customerName.split(' ')[0], mode: 'insensitive' } },
          { lastName: { contains: customerName.split(' ').slice(-1)[0], mode: 'insensitive' } },
        ],
      },
      include: {
        contracts: {
          include: {
            payments: {
              orderBy: { createdAt: 'desc' },
            },
            installments: {
              orderBy: { installmentNo: 'asc' },
            },
            inventoryItem: {
              include: {
                product: true,
              },
            },
          },
        },
      },
    });

    if (customers.length === 0) {
      console.log(`❌ No customer found with name: ${customerName}`);
      return;
    }

    for (const customer of customers) {
      console.log(`\n📋 CUSTOMER DETAILS`);
      console.log(`==================`);
      console.log(`Name: ${customer.firstName} ${customer.lastName}`);
      console.log(`Membership ID: ${customer.membershipId}`);
      console.log(`Phone: ${customer.phone}`);
      console.log(`Email: ${customer.email || 'N/A'}`);
      console.log(`Status: ${customer.isActivated ? '✅ Activated' : '⏳ Pending'}`);

      if (customer.contracts.length === 0) {
        console.log(`\n⚠️  No contracts found for this customer.`);
        continue;
      }

      for (const contract of customer.contracts) {
        console.log(`\n\n💼 CONTRACT: ${contract.contractNumber}`);
        console.log(`==========================================`);
        console.log(`Status: ${contract.status}`);
        console.log(`Start Date: ${contract.startDate.toLocaleDateString()}`);
        console.log(`End Date: ${contract.endDate.toLocaleDateString()}`);

        if (contract.inventoryItem) {
          console.log(`\n📦 Product: ${contract.inventoryItem.product.name}`);
          console.log(`Serial Number: ${contract.inventoryItem.serialNumber}`);
        }

        console.log(`\n💰 FINANCIAL BREAKDOWN`);
        console.log(`==========================================`);
        console.log(`Total Price:            GHS ${contract.totalPrice.toFixed(2)}`);
        console.log(`Deposit Amount:         GHS ${contract.depositAmount.toFixed(2)}`);
        console.log(`Finance Amount:         GHS ${contract.financeAmount.toFixed(2)}`);
        console.log(`Installment Amount:     GHS ${contract.installmentAmount.toFixed(2)}`);
        console.log(`Payment Frequency:      ${contract.paymentFrequency}`);
        console.log(`Total Installments:     ${contract.totalInstallments}`);
        console.log(`\n--- CALCULATED VALUES ---`);
        console.log(`Expected Total Payments: GHS ${(contract.depositAmount + (contract.installmentAmount * contract.totalInstallments)).toFixed(2)}`);
        console.log(`Total Paid (DB):        GHS ${contract.totalPaid.toFixed(2)}`);
        console.log(`Outstanding Balance:    GHS ${contract.outstandingBalance.toFixed(2)}`);

        // Calculate actual payments sum
        const successfulPayments = contract.payments.filter(p => p.status === 'SUCCESS');
        const actualTotalPaid = successfulPayments.reduce((sum, p) => sum + p.amount, 0);

        console.log(`\n📊 PAYMENT RECONCILIATION`);
        console.log(`==========================================`);
        console.log(`Total Paid (Contract):     GHS ${contract.totalPaid.toFixed(2)}`);
        console.log(`Actual Payments Sum:       GHS ${actualTotalPaid.toFixed(2)}`);
        console.log(`Difference:                GHS ${(contract.totalPaid - actualTotalPaid).toFixed(2)}`);

        if (Math.abs(contract.totalPaid - actualTotalPaid) > 0.01) {
          console.log(`⚠️  WARNING: Contract totalPaid does not match sum of successful payments!`);
        }

        console.log(`\n📝 PAYMENT TRANSACTIONS (${contract.payments.length} total)`);
        console.log(`==========================================`);
        console.log(`Successful: ${successfulPayments.length}`);
        console.log(`Pending: ${contract.payments.filter(p => p.status === 'PENDING').length}`);
        console.log(`Failed: ${contract.payments.filter(p => p.status === 'FAILED').length}`);

        if (contract.payments.length > 0) {
          console.log(`\nRecent Payments:`);
          contract.payments.slice(0, 10).forEach((payment) => {
            const statusIcon = payment.status === 'SUCCESS' ? '✅' : payment.status === 'FAILED' ? '❌' : '⏳';
            console.log(`  ${statusIcon} ${payment.transactionRef}`);
            console.log(`     Amount: GHS ${payment.amount.toFixed(2)}`);
            console.log(`     Status: ${payment.status}`);
            console.log(`     Date: ${payment.paymentDate ? payment.paymentDate.toLocaleString() : 'N/A'}`);
            console.log(`     Method: ${payment.paymentMethod}`);
            if (payment.failureReason) {
              console.log(`     Failure Reason: ${payment.failureReason}`);
            }
            console.log(``);
          });
        }

        console.log(`\n📅 INSTALLMENT SCHEDULE`);
        console.log(`==========================================`);
        const paidInstallments = contract.installments.filter(i => i.status === 'PAID');
        const pendingInstallments = contract.installments.filter(i => i.status === 'PENDING');
        const overdueInstallments = contract.installments.filter(i => i.status === 'OVERDUE');
        const partialInstallments = contract.installments.filter(i => i.status === 'PARTIAL');

        console.log(`Paid: ${paidInstallments.length}`);
        console.log(`Pending: ${pendingInstallments.length}`);
        console.log(`Overdue: ${overdueInstallments.length}`);
        console.log(`Partial: ${partialInstallments.length}`);

        const totalInstallmentsPaid = contract.installments.reduce((sum, i) => sum + i.paidAmount, 0);
        console.log(`\nTotal Paid via Installments: GHS ${totalInstallmentsPaid.toFixed(2)}`);

        console.log(`\nInstallment Details:`);
        contract.installments.forEach((installment) => {
          const statusIcon =
            installment.status === 'PAID' ? '✅' :
            installment.status === 'OVERDUE' ? '⚠️' :
            installment.status === 'PARTIAL' ? '⏺️' : '⏳';

          console.log(`  ${statusIcon} #${installment.installmentNo} - Due: ${installment.dueDate.toLocaleDateString()}`);
          console.log(`     Amount: GHS ${installment.amount.toFixed(2)}`);
          console.log(`     Paid: GHS ${installment.paidAmount.toFixed(2)}`);
          console.log(`     Status: ${installment.status}`);
          if (installment.paidAt) {
            console.log(`     Paid At: ${installment.paidAt.toLocaleString()}`);
          }
          console.log(``);
        });

        // Check for discrepancies
        console.log(`\n🔍 DISCREPANCY ANALYSIS`);
        console.log(`==========================================`);

        const expectedContractValue = contract.depositAmount + contract.financeAmount;
        if (Math.abs(expectedContractValue - contract.totalPrice) > 0.01) {
          console.log(`❌ ISSUE: Deposit + Finance ≠ Total Price`);
          console.log(`   Deposit: ${contract.depositAmount.toFixed(2)}`);
          console.log(`   Finance: ${contract.financeAmount.toFixed(2)}`);
          console.log(`   Sum: ${expectedContractValue.toFixed(2)}`);
          console.log(`   Total Price: ${contract.totalPrice.toFixed(2)}`);
          console.log(`   Difference: ${(contract.totalPrice - expectedContractValue).toFixed(2)}`);
        }

        const expectedPayments = contract.depositAmount + (contract.installmentAmount * contract.totalInstallments);
        const calculatedOutstanding = expectedPayments - contract.totalPaid;

        if (Math.abs(calculatedOutstanding - contract.outstandingBalance) > 0.01) {
          console.log(`❌ ISSUE: Outstanding balance mismatch`);
          console.log(`   Expected Outstanding: ${calculatedOutstanding.toFixed(2)}`);
          console.log(`   DB Outstanding: ${contract.outstandingBalance.toFixed(2)}`);
          console.log(`   Difference: ${(contract.outstandingBalance - calculatedOutstanding).toFixed(2)}`);
        }

        if (Math.abs(contract.totalPaid - actualTotalPaid) > 0.01) {
          console.log(`❌ ISSUE: Contract totalPaid ≠ Sum of successful payments`);
          console.log(`   Contract totalPaid: ${contract.totalPaid.toFixed(2)}`);
          console.log(`   Actual payments sum: ${actualTotalPaid.toFixed(2)}`);
          console.log(`   Difference: ${(contract.totalPaid - actualTotalPaid).toFixed(2)}`);
        }

        if (Math.abs(actualTotalPaid - totalInstallmentsPaid) > 0.01) {
          console.log(`❌ ISSUE: Payment transactions ≠ Installment payments`);
          console.log(`   Payment transactions: ${actualTotalPaid.toFixed(2)}`);
          console.log(`   Installment payments: ${totalInstallmentsPaid.toFixed(2)}`);
          console.log(`   Difference: ${(actualTotalPaid - totalInstallmentsPaid).toFixed(2)}`);
        }

        if (Math.abs(contract.totalPaid - actualTotalPaid) <= 0.01 &&
            Math.abs(calculatedOutstanding - contract.outstandingBalance) <= 0.01 &&
            Math.abs(actualTotalPaid - totalInstallmentsPaid) <= 0.01) {
          console.log(`✅ All values reconcile correctly!`);
        }
      }
    }

  } catch (error) {
    console.error('Error checking customer payments:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Get customer name from command line arguments
const customerName = process.argv[2] || 'ANTHONY OSEI';
checkCustomerPayments(customerName);

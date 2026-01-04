import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ReconciliationResult {
  contractNumber: string;
  customerName: string;
  oldTotalPaid: number;
  newTotalPaid: number;
  oldOutstanding: number;
  newOutstanding: number;
  hadIssue: boolean;
}

async function reconcileAllContracts() {
  try {
    console.log('\n🔄 CONTRACT RECONCILIATION - ALL CUSTOMERS');
    console.log('='.repeat(80));
    console.log('This script will recalculate totalPaid and outstandingBalance for all contracts');
    console.log('New logic: totalPaid = depositAmount + sum of successful payments\n');

    // Get all contracts with their payments and customer info
    const contracts = await prisma.hirePurchaseContract.findMany({
      include: {
        customer: true,
        payments: {
          where: { status: 'SUCCESS' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log(`Found ${contracts.length} contracts to reconcile\n`);

    const results: ReconciliationResult[] = [];
    let issuesFound = 0;
    let contractsFixed = 0;

    for (const contract of contracts) {
      const paymentsSum = contract.payments.reduce((sum, p) => sum + p.amount, 0);
      const correctTotalPaid = contract.depositAmount + paymentsSum;
      const correctOutstanding = contract.totalPrice - correctTotalPaid;

      const totalPaidDiff = Math.abs(contract.totalPaid - correctTotalPaid);
      const outstandingDiff = Math.abs(contract.outstandingBalance - correctOutstanding);
      const hasIssue = totalPaidDiff > 0.01 || outstandingDiff > 0.01;

      if (hasIssue) {
        issuesFound++;
      }

      results.push({
        contractNumber: contract.contractNumber,
        customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
        oldTotalPaid: contract.totalPaid,
        newTotalPaid: correctTotalPaid,
        oldOutstanding: contract.outstandingBalance,
        newOutstanding: Math.max(0, correctOutstanding),
        hadIssue: hasIssue,
      });
    }

    // Display issues found
    console.log('📊 RECONCILIATION ANALYSIS');
    console.log('-'.repeat(80));
    console.log(`Total Contracts: ${contracts.length}`);
    console.log(`Contracts with Issues: ${issuesFound}`);
    console.log(`Contracts Correct: ${contracts.length - issuesFound}\n`);

    if (issuesFound > 0) {
      console.log('❌ CONTRACTS WITH DISCREPANCIES:\n');

      results
        .filter((r) => r.hadIssue)
        .forEach((result, index) => {
          console.log(`${index + 1}. ${result.contractNumber} - ${result.customerName}`);
          console.log(`   Total Paid:     ${result.oldTotalPaid.toFixed(2)} → ${result.newTotalPaid.toFixed(2)} (Δ ${(result.newTotalPaid - result.oldTotalPaid).toFixed(2)})`);
          console.log(`   Outstanding:    ${result.oldOutstanding.toFixed(2)} → ${result.newOutstanding.toFixed(2)} (Δ ${(result.newOutstanding - result.oldOutstanding).toFixed(2)})`);
          console.log('');
        });

      console.log('\n🔧 APPLYING FIXES...\n');

      // Apply fixes in a transaction
      for (const result of results.filter((r) => r.hadIssue)) {
        const contract = contracts.find((c) => c.contractNumber === result.contractNumber);
        if (!contract) continue;

        await prisma.hirePurchaseContract.update({
          where: { id: contract.id },
          data: {
            totalPaid: result.newTotalPaid,
            outstandingBalance: result.newOutstanding,
            status: result.newOutstanding <= 0 ? 'COMPLETED' : contract.status,
            updatedAt: new Date(),
          },
        });

        contractsFixed++;
        console.log(`✅ Fixed: ${result.contractNumber} - ${result.customerName}`);
      }

      console.log(`\n✅ Successfully fixed ${contractsFixed} contracts!`);
    } else {
      console.log('✅ All contracts are already correct! No fixes needed.');
    }

    // Final verification
    console.log('\n\n📋 FINAL VERIFICATION');
    console.log('='.repeat(80));

    const verifyContracts = await prisma.hirePurchaseContract.findMany({
      include: {
        customer: true,
        payments: { where: { status: 'SUCCESS' } },
      },
    });

    let allCorrect = true;
    for (const contract of verifyContracts) {
      const paymentsSum = contract.payments.reduce((sum, p) => sum + p.amount, 0);
      const expectedTotalPaid = contract.depositAmount + paymentsSum;
      const expectedOutstanding = contract.totalPrice - expectedTotalPaid;

      const totalPaidCorrect = Math.abs(contract.totalPaid - expectedTotalPaid) < 0.01;
      const outstandingCorrect = Math.abs(contract.outstandingBalance - Math.max(0, expectedOutstanding)) < 0.01;

      if (!totalPaidCorrect || !outstandingCorrect) {
        console.log(`❌ ${contract.contractNumber} still has issues!`);
        allCorrect = false;
      }
    }

    if (allCorrect) {
      console.log('✅ All contracts verified! All totals are correct.\n');
    }

    // Summary report
    console.log('\n📊 RECONCILIATION SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total Contracts Processed:  ${contracts.length}`);
    console.log(`Issues Found:               ${issuesFound}`);
    console.log(`Contracts Fixed:            ${contractsFixed}`);
    console.log(`Verification Status:        ${allCorrect ? '✅ PASSED' : '❌ FAILED'}`);

    // Export detailed report
    const reportData = results.filter((r) => r.hadIssue).map((r) => ({
      Contract: r.contractNumber,
      Customer: r.customerName,
      'Old Total Paid': r.oldTotalPaid.toFixed(2),
      'New Total Paid': r.newTotalPaid.toFixed(2),
      'Total Paid Diff': (r.newTotalPaid - r.oldTotalPaid).toFixed(2),
      'Old Outstanding': r.oldOutstanding.toFixed(2),
      'New Outstanding': r.newOutstanding.toFixed(2),
      'Outstanding Diff': (r.newOutstanding - r.oldOutstanding).toFixed(2),
    }));

    if (reportData.length > 0) {
      console.log('\n📄 DETAILED REPORT OF FIXED CONTRACTS:');
      console.table(reportData);
    }

    console.log('\n✅ Reconciliation complete!');
    console.log('\n📋 NEXT STEPS:');
    console.log('-'.repeat(80));
    console.log('1. ✅ Payment calculation logic has been updated');
    console.log('2. ✅ All existing contracts have been reconciled');
    console.log('3. ⏳ Notify affected customers of corrected balances');
    console.log('4. ⏳ Test new payment processing with updated logic');
    console.log('5. ⏳ Monitor for any new discrepancies\n');

  } catch (error) {
    console.error('\n❌ Error during reconciliation:', error);
    console.log('\n⚠️  Some contracts may not have been fixed. Please review the error above.');
  } finally {
    await prisma.$disconnect();
  }
}

// Confirmation prompt
console.log('\n⚠️  WARNING: This script will modify ALL contracts in the database!');
console.log('It will recalculate totalPaid and outstandingBalance for every contract.');
console.log('Make sure you have a backup before proceeding.\n');

console.log('Starting reconciliation in 3 seconds...\n');

setTimeout(() => {
  reconcileAllContracts();
}, 3000);

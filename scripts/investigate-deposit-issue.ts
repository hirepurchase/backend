import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function investigateDepositIssue() {
  try {
    console.log('\n🔍 FORENSIC INVESTIGATION: Anthony Osei Deposit Issue');
    console.log('='.repeat(70));

    // Find the contract
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { contractNumber: 'CON26016MD9NL' },
      include: {
        customer: true,
        createdBy: true,
        payments: {
          orderBy: { createdAt: 'asc' },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      console.log('❌ Contract not found!');
      return;
    }

    console.log('\n📋 CONTRACT DETAILS');
    console.log('-'.repeat(70));
    console.log(`Contract Number: ${contract.contractNumber}`);
    console.log(`Customer: ${contract.customer.firstName} ${contract.customer.lastName}`);
    console.log(`Created By: ${contract.createdBy.firstName} ${contract.createdBy.lastName}`);
    console.log(`Created At: ${contract.createdAt.toLocaleString()}`);
    console.log(`Updated At: ${contract.updatedAt.toLocaleString()}`);

    console.log('\n💰 FINANCIAL DATA');
    console.log('-'.repeat(70));
    console.log(`Total Price:         GHS ${contract.totalPrice.toFixed(2)}`);
    console.log(`Deposit Amount:      GHS ${contract.depositAmount.toFixed(2)}`);
    console.log(`Finance Amount:      GHS ${contract.financeAmount.toFixed(2)}`);
    console.log(`Total Paid (DB):     GHS ${contract.totalPaid.toFixed(2)}`);
    console.log(`Outstanding (DB):    GHS ${contract.outstandingBalance.toFixed(2)}`);

    // Check 1: Audit Logs for Contract
    console.log('\n\n📜 AUDIT LOG - Contract Actions');
    console.log('-'.repeat(70));

    const contractAudits = await prisma.auditLog.findMany({
      where: {
        entity: 'HirePurchaseContract',
        entityId: contract.id,
      },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (contractAudits.length === 0) {
      console.log('⚠️  NO AUDIT LOGS FOUND - Contract may have been created manually in DB!');
    } else {
      contractAudits.forEach((audit) => {
        console.log(`\n[${audit.createdAt.toLocaleString()}] ${audit.action}`);
        if (audit.user) {
          console.log(`  By: ${audit.user.firstName} ${audit.user.lastName} (${audit.user.email})`);
        }
        if (audit.oldValues) {
          console.log(`  Old Values: ${audit.oldValues.substring(0, 200)}${audit.oldValues.length > 200 ? '...' : ''}`);
        }
        if (audit.newValues) {
          console.log(`  New Values: ${audit.newValues.substring(0, 200)}${audit.newValues.length > 200 ? '...' : ''}`);
        }
      });
    }

    // Check 2: Payment Transactions
    console.log('\n\n💳 PAYMENT TRANSACTIONS');
    console.log('-'.repeat(70));

    if (contract.payments.length === 0) {
      console.log('❌ NO PAYMENT TRANSACTIONS FOUND!');
    } else {
      console.log(`Total Transactions: ${contract.payments.length}\n`);
      contract.payments.forEach((payment, index) => {
        console.log(`${index + 1}. ${payment.transactionRef}`);
        console.log(`   Amount: GHS ${payment.amount.toFixed(2)}`);
        console.log(`   Status: ${payment.status}`);
        console.log(`   Method: ${payment.paymentMethod}`);
        console.log(`   Payment Date: ${payment.paymentDate ? payment.paymentDate.toLocaleString() : 'N/A'}`);
        console.log(`   Created At: ${payment.createdAt.toLocaleString()}`);
        console.log('');
      });

      const successfulPayments = contract.payments.filter((p) => p.status === 'SUCCESS');
      const totalFromPayments = successfulPayments.reduce((sum, p) => sum + p.amount, 0);

      console.log(`Successful Payments: ${successfulPayments.length}`);
      console.log(`Total from Payments: GHS ${totalFromPayments.toFixed(2)}`);
      console.log(`Contract totalPaid:  GHS ${contract.totalPaid.toFixed(2)}`);
      console.log(`Difference:          GHS ${(contract.totalPaid - totalFromPayments).toFixed(2)}`);
    }

    // Check 3: Deleted Payment Transactions
    console.log('\n\n🗑️  DELETED PAYMENT TRANSACTIONS');
    console.log('-'.repeat(70));

    const deletedPayments = await prisma.auditLog.findMany({
      where: {
        entity: 'PaymentTransaction',
        action: 'DELETE',
      },
      include: {
        user: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const relevantDeleted = deletedPayments.filter((audit) =>
      audit.oldValues?.includes(contract.contractNumber) || audit.oldValues?.includes(contract.id)
    );

    if (relevantDeleted.length === 0) {
      console.log('✅ No deleted payment transactions found for this contract');
    } else {
      console.log(`⚠️  FOUND ${relevantDeleted.length} DELETED PAYMENT(S)!`);
      relevantDeleted.forEach((audit) => {
        console.log(`\n[${audit.createdAt.toLocaleString()}]`);
        if (audit.user) {
          console.log(`  Deleted By: ${audit.user.firstName} ${audit.user.lastName}`);
        }
        console.log(`  Old Values: ${audit.oldValues}`);
      });
    }

    // Check 4: Installment Schedule
    console.log('\n\n📅 INSTALLMENT SCHEDULE ANALYSIS');
    console.log('-'.repeat(70));

    const totalInstallmentPaid = contract.installments.reduce((sum, i) => sum + i.paidAmount, 0);
    console.log(`Total Paid via Installments: GHS ${totalInstallmentPaid.toFixed(2)}`);

    const successfulPayments = contract.payments.filter((p) => p.status === 'SUCCESS');
    const totalFromPayments = successfulPayments.reduce((sum, p) => sum + p.amount, 0);

    console.log(`Total from Payment Txns:     GHS ${totalFromPayments.toFixed(2)}`);
    console.log(`Difference:                  GHS ${(totalInstallmentPaid - totalFromPayments).toFixed(2)}`);

    // Check 5: Timeline Analysis
    console.log('\n\n⏱️  TIMELINE ANALYSIS');
    console.log('-'.repeat(70));

    console.log(`Contract Created: ${contract.createdAt.toLocaleString()}`);
    if (contract.payments.length > 0) {
      const firstPayment = contract.payments[0];
      console.log(`First Payment:    ${firstPayment.createdAt.toLocaleString()}`);
      console.log(`Time Difference:  ${Math.round((firstPayment.createdAt.getTime() - contract.createdAt.getTime()) / (1000 * 60 * 60))} hours`);
    }

    // Check 6: Calculate What Should Be
    console.log('\n\n🧮 CALCULATED vs ACTUAL');
    console.log('-'.repeat(70));

    const expectedTotalPayments = contract.depositAmount + (contract.installmentAmount * contract.totalInstallments);
    const calculatedOutstanding = expectedTotalPayments - contract.totalPaid;
    const actualPaymentSum = successfulPayments.reduce((sum, p) => sum + p.amount, 0);

    console.log('EXPECTED (Based on Contract Terms):');
    console.log(`  Total Required:      GHS ${expectedTotalPayments.toFixed(2)}`);
    console.log(`  Already Paid:        GHS ${contract.totalPaid.toFixed(2)}`);
    console.log(`  Outstanding:         GHS ${calculatedOutstanding.toFixed(2)}`);

    console.log('\nACTUAL (Based on Payment Records):');
    console.log(`  Deposit Amount:      GHS ${contract.depositAmount.toFixed(2)} (should be in totalPaid)`);
    console.log(`  Payment Txns Sum:    GHS ${actualPaymentSum.toFixed(2)}`);
    console.log(`  Total Should Be:     GHS ${(contract.depositAmount + actualPaymentSum).toFixed(2)}`);

    console.log('\nDATABASE VALUES:');
    console.log(`  DB totalPaid:        GHS ${contract.totalPaid.toFixed(2)}`);
    console.log(`  DB outstanding:      GHS ${contract.outstandingBalance.toFixed(2)}`);

    console.log('\nDISCREPANCIES:');
    const depositMissing = contract.depositAmount - (contract.totalPaid - actualPaymentSum);
    const outstandingError = calculatedOutstanding - contract.outstandingBalance;

    if (Math.abs(depositMissing) > 0.01) {
      console.log(`  ❌ Deposit missing from totalPaid: GHS ${depositMissing.toFixed(2)}`);
    } else {
      console.log(`  ✅ Deposit correctly included in totalPaid`);
    }

    if (Math.abs(outstandingError) > 0.01) {
      console.log(`  ❌ Outstanding balance incorrect by: GHS ${Math.abs(outstandingError).toFixed(2)}`);
    } else {
      console.log(`  ✅ Outstanding balance is correct`);
    }

    // Final Conclusion
    console.log('\n\n🎯 CONCLUSION');
    console.log('='.repeat(70));

    if (contractAudits.length === 0) {
      console.log('⚠️  Contract has NO audit logs - likely created manually in database');
      console.log('   This bypassed the automatic deposit initialization in the code.');
    }

    if (Math.abs(contract.totalPaid - actualPaymentSum) < 0.01) {
      console.log('✅ totalPaid matches sum of payment transactions exactly');
      console.log('   This means deposit was NEVER recorded in totalPaid');
      console.log(`   Missing deposit: GHS ${contract.depositAmount.toFixed(2)}`);
    }

    if (contract.payments.length > 0) {
      const depositPayment = contract.payments.find((p) => p.amount === contract.depositAmount);
      if (!depositPayment) {
        console.log(`❌ No payment transaction found for deposit amount (GHS ${contract.depositAmount.toFixed(2)})`);
      } else {
        console.log(`✅ Found payment matching deposit: ${depositPayment.transactionRef}`);
      }
    }

    console.log('\n📋 RECOMMENDED ACTION:');
    console.log('-'.repeat(70));
    console.log('1. Verify with customer if deposit was paid (call 0245504241)');
    console.log('2. Check cash records from January 3, 2026');
    console.log('3. Check contract signing documents');
    console.log('\nIf deposit WAS paid:');
    console.log('  - Run fix script to add deposit payment record');
    console.log('  - Update totalPaid to 1,300.67');
    console.log('  - Update outstandingBalance to 399.34');
    console.log('\nIf deposit was NOT paid:');
    console.log('  - Update outstandingBalance to 699.34');
    console.log('  - Notify customer of outstanding deposit');

  } catch (error) {
    console.error('\n❌ Error during investigation:', error);
  } finally {
    await prisma.$disconnect();
  }
}

investigateDepositIssue();

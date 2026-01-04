import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixDepositIssue() {
  try {
    console.log('🔧 Fixing Anthony Osei deposit issue...\n');

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { contractNumber: 'CON26016MD9NL' },
      include: {
        customer: true,
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        payments: {
          where: { status: 'SUCCESS' },
        },
      },
    });

    if (!contract) {
      console.log('❌ Contract not found!');
      return;
    }

    console.log('📋 Contract: CON26016MD9NL');
    console.log(`Customer: ${contract.customer.firstName} ${contract.customer.lastName}`);
    console.log('\n💰 CURRENT STATE:');
    console.log(`  Total Price:     GHS ${contract.totalPrice.toFixed(2)}`);
    console.log(`  Deposit Amount:  GHS ${contract.depositAmount.toFixed(2)}`);
    console.log(`  Finance Amount:  GHS ${contract.financeAmount.toFixed(2)}`);
    console.log(`  Total Paid:      GHS ${contract.totalPaid.toFixed(2)}`);
    console.log(`  Outstanding:     GHS ${contract.outstandingBalance.toFixed(2)}`);

    const actualPayments = contract.payments.reduce((sum, p) => sum + p.amount, 0);
    console.log(`  Actual Payments: GHS ${actualPayments.toFixed(2)}`);
    console.log(`  Missing Deposit: GHS ${contract.depositAmount.toFixed(2)}`);

    // Check if deposit payment already exists
    const existingDeposit = await prisma.paymentTransaction.findFirst({
      where: {
        contractId: contract.id,
        transactionRef: 'DEPOSIT-CON26016MD9NL-BACKFILL',
      },
    });

    if (existingDeposit) {
      console.log('\n⚠️  Deposit payment record already exists! Fix may have been applied already.');
      console.log('   Exiting to prevent duplicate fix.');
      return;
    }

    console.log('\n🔄 APPLYING FIX...\n');

    // Create the fix in a transaction
    await prisma.$transaction(async (tx) => {
      // 1. Create deposit payment record
      const depositPayment = await tx.paymentTransaction.create({
        data: {
          transactionRef: 'DEPOSIT-CON26016MD9NL-BACKFILL',
          contractId: contract.id,
          customerId: contract.customerId,
          amount: contract.depositAmount,
          paymentMethod: 'CASH',
          mobileMoneyProvider: null,
          mobileMoneyNumber: null,
          status: 'SUCCESS',
          externalRef: 'MANUAL_BACKFILL',
          paymentDate: contract.createdAt,
          metadata: JSON.stringify({
            note: 'Deposit payment backfilled on 2026-01-04',
            reason: 'Deposit was paid but not recorded in system',
            original_contract_date: contract.createdAt,
          }),
          createdAt: contract.createdAt,
          updatedAt: new Date(),
        },
      });

      console.log(`✅ Step 1: Created deposit payment record`);
      console.log(`   Transaction Ref: ${depositPayment.transactionRef}`);
      console.log(`   Amount: GHS ${depositPayment.amount.toFixed(2)}`);
      console.log(`   Date: ${depositPayment.paymentDate?.toLocaleString()}`);

      // 2. Update contract totals
      const newTotalPaid = contract.totalPaid + contract.depositAmount;
      const newOutstanding = contract.outstandingBalance - contract.depositAmount;

      const updatedContract = await tx.hirePurchaseContract.update({
        where: { id: contract.id },
        data: {
          totalPaid: newTotalPaid,
          outstandingBalance: newOutstanding,
          updatedAt: new Date(),
        },
      });

      console.log(`\n✅ Step 2: Updated contract totals`);
      console.log(`   Total Paid: GHS ${contract.totalPaid.toFixed(2)} → GHS ${updatedContract.totalPaid.toFixed(2)}`);
      console.log(`   Outstanding: GHS ${contract.outstandingBalance.toFixed(2)} → GHS ${updatedContract.outstandingBalance.toFixed(2)}`);

      // 3. Update first installment to reflect deposit application
      const firstInstallment = contract.installments[0];
      const newPaidAmount = firstInstallment.paidAmount + contract.depositAmount;

      // Determine new status
      let newStatus = firstInstallment.status;
      if (newPaidAmount >= firstInstallment.amount) {
        newStatus = 'PAID';
      } else if (newPaidAmount > 0) {
        newStatus = 'PARTIAL';
      }

      const updatedInstallment = await tx.installmentSchedule.update({
        where: { id: firstInstallment.id },
        data: {
          paidAmount: newPaidAmount,
          status: newStatus,
          paidAt: newStatus === 'PAID' ? contract.createdAt : firstInstallment.paidAt,
          updatedAt: new Date(),
        },
      });

      console.log(`\n✅ Step 3: Updated installment #1`);
      console.log(`   Paid Amount: GHS ${firstInstallment.paidAmount.toFixed(2)} → GHS ${updatedInstallment.paidAmount.toFixed(2)}`);
      console.log(`   Status: ${firstInstallment.status} → ${updatedInstallment.status}`);
    });

    console.log('\n\n🎉 FIX COMPLETED SUCCESSFULLY!\n');
    console.log('=' .repeat(60));

    // Fetch updated contract for verification
    const verifiedContract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contract.id },
      include: {
        payments: { where: { status: 'SUCCESS' } },
        installments: { orderBy: { installmentNo: 'asc' } },
      },
    });

    if (verifiedContract) {
      const totalPaymentsSum = verifiedContract.payments.reduce((sum, p) => sum + p.amount, 0);
      const totalInstallmentsPaid = verifiedContract.installments.reduce((sum, i) => sum + i.paidAmount, 0);

      console.log('\n✅ VERIFICATION RESULTS:');
      console.log('-'.repeat(60));
      console.log(`Total Paid (Contract):        GHS ${verifiedContract.totalPaid.toFixed(2)}`);
      console.log(`Sum of Payment Transactions:  GHS ${totalPaymentsSum.toFixed(2)}`);
      console.log(`Sum of Installment Payments:  GHS ${totalInstallmentsPaid.toFixed(2)}`);
      console.log(`Outstanding Balance:          GHS ${verifiedContract.outstandingBalance.toFixed(2)}`);

      console.log('\n✅ CALCULATIONS:');
      console.log(`Expected Total:               GHS ${(contract.depositAmount + (contract.installmentAmount * contract.totalInstallments)).toFixed(2)}`);
      console.log(`Amount Paid:                  GHS ${verifiedContract.totalPaid.toFixed(2)}`);
      console.log(`Still Owed:                   GHS ${verifiedContract.outstandingBalance.toFixed(2)}`);

      // Validation
      const paymentMatch = Math.abs(verifiedContract.totalPaid - totalPaymentsSum) < 0.01;
      const installmentMatch = Math.abs(totalPaymentsSum - totalInstallmentsPaid) < 0.01;

      console.log('\n✅ INTEGRITY CHECKS:');
      console.log(`Payment transactions match contract total: ${paymentMatch ? '✅ YES' : '❌ NO'}`);
      console.log(`Installments match payment transactions:  ${installmentMatch ? '✅ YES' : '❌ NO'}`);

      if (paymentMatch && installmentMatch) {
        console.log('\n🎊 All values reconcile correctly! The fix was successful.');
      } else {
        console.log('\n⚠️  Warning: Some values do not reconcile. Please investigate.');
      }
    }

    console.log('\n📋 NEXT STEPS:');
    console.log('-'.repeat(60));
    console.log('1. ✅ Deposit has been recorded');
    console.log('2. ✅ Contract totals have been updated');
    console.log('3. ✅ Installment schedule has been updated');
    console.log('4. ⏳ Notify customer of corrected balance');
    console.log('5. ⏳ Update customer statement');
    console.log(`6. ⏳ Call customer: ${contract.customer.phone}`);

  } catch (error) {
    console.error('\n❌ Error during fix:', error);
    console.log('\n⚠️  Transaction was rolled back. No changes were made.');
  } finally {
    await prisma.$disconnect();
  }
}

// Run the fix
console.log('⚠️  WARNING: This script will modify the database!');
console.log('Make sure you have a backup before proceeding.\n');

fixDepositIssue();

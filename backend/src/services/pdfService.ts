import PDFDocument from 'pdfkit';
import { formatCurrency } from '../utils/helpers';

interface ContractStatementData {
  contract: {
    contractNumber: string;
    totalPrice: number;
    depositAmount: number;
    financeAmount: number;
    installmentAmount: number;
    paymentFrequency: string;
    totalInstallments: number;
    startDate: Date;
    endDate: Date;
    status: string;
    totalPaid: number;
    outstandingBalance: number;
    ownershipTransferred: boolean;
  };
  customer: {
    membershipId: string;
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
    address: string | null;
  };
  product: {
    name: string;
    serialNumber: string;
    category: string;
  };
  installments: Array<{
    installmentNo: number;
    dueDate: Date;
    amount: number;
    paidAmount: number;
    status: string;
    paidAt: Date | null;
  }>;
  payments: Array<{
    transactionRef: string;
    amount: number;
    paymentDate: Date | null;
    status: string;
    paymentMethod: string;
  }>;
}

export function generateContractStatement(data: ContractStatementData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ margin: 50 });

  // Header
  doc.fontSize(20).text('HIRE PURCHASE STATEMENT', { align: 'center' });
  doc.moveDown();
  doc.fontSize(10).text(`Generated: ${new Date().toLocaleDateString()}`, { align: 'right' });
  doc.moveDown(2);

  // Contract Information
  doc.fontSize(14).text('Contract Information', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Contract Number: ${data.contract.contractNumber}`);
  doc.text(`Status: ${data.contract.status}`);
  doc.text(`Start Date: ${new Date(data.contract.startDate).toLocaleDateString()}`);
  doc.text(`End Date: ${new Date(data.contract.endDate).toLocaleDateString()}`);
  doc.text(`Payment Frequency: ${data.contract.paymentFrequency}`);
  doc.moveDown();

  // Customer Information
  doc.fontSize(14).text('Customer Information', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Membership ID: ${data.customer.membershipId}`);
  doc.text(`Name: ${data.customer.firstName} ${data.customer.lastName}`);
  doc.text(`Phone: ${data.customer.phone}`);
  if (data.customer.email) doc.text(`Email: ${data.customer.email}`);
  if (data.customer.address) doc.text(`Address: ${data.customer.address}`);
  doc.moveDown();

  // Product Information
  doc.fontSize(14).text('Product Information', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Product: ${data.product.name}`);
  doc.text(`Category: ${data.product.category}`);
  doc.text(`Serial/IMEI: ${data.product.serialNumber}`);
  doc.text(`Ownership Transferred: ${data.contract.ownershipTransferred ? 'Yes' : 'No'}`);
  doc.moveDown();

  // Financial Summary
  doc.fontSize(14).text('Financial Summary', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10);

  const summaryData = [
    ['Total Price:', formatCurrency(data.contract.totalPrice)],
    ['Deposit Paid:', formatCurrency(data.contract.depositAmount)],
    ['Financed Amount:', formatCurrency(data.contract.financeAmount)],
    ['Installment Amount:', formatCurrency(data.contract.installmentAmount)],
    ['Total Installments:', data.contract.totalInstallments.toString()],
    ['Total Paid:', formatCurrency(data.contract.totalPaid)],
    ['Outstanding Balance:', formatCurrency(data.contract.outstandingBalance)],
  ];

  summaryData.forEach(([label, value]) => {
    doc.text(`${label} ${value}`);
  });
  doc.moveDown();

  // Installment Schedule
  doc.fontSize(14).text('Installment Schedule', { underline: true });
  doc.moveDown(0.5);

  // Table header
  const tableTop = doc.y;
  const col1 = 50;
  const col2 = 100;
  const col3 = 200;
  const col4 = 280;
  const col5 = 360;
  const col6 = 440;

  doc.fontSize(9);
  doc.text('#', col1, tableTop, { width: 40 });
  doc.text('Due Date', col2, tableTop, { width: 90 });
  doc.text('Amount', col3, tableTop, { width: 70 });
  doc.text('Paid', col4, tableTop, { width: 70 });
  doc.text('Status', col5, tableTop, { width: 70 });
  doc.text('Paid Date', col6, tableTop, { width: 90 });

  doc.moveTo(col1, tableTop + 15).lineTo(530, tableTop + 15).stroke();

  let y = tableTop + 20;

  data.installments.forEach((inst) => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    doc.text(inst.installmentNo.toString(), col1, y, { width: 40 });
    doc.text(new Date(inst.dueDate).toLocaleDateString(), col2, y, { width: 90 });
    doc.text(formatCurrency(inst.amount), col3, y, { width: 70 });
    doc.text(formatCurrency(inst.paidAmount), col4, y, { width: 70 });
    doc.text(inst.status, col5, y, { width: 70 });
    doc.text(inst.paidAt ? new Date(inst.paidAt).toLocaleDateString() : '-', col6, y, { width: 90 });

    y += 18;
  });

  // Payment History
  if (data.payments.length > 0) {
    doc.addPage();
    doc.fontSize(14).text('Payment History', { underline: true });
    doc.moveDown(0.5);

    const payTableTop = doc.y;

    doc.fontSize(9);
    doc.text('Reference', 50, payTableTop, { width: 120 });
    doc.text('Amount', 180, payTableTop, { width: 80 });
    doc.text('Method', 270, payTableTop, { width: 80 });
    doc.text('Date', 360, payTableTop, { width: 80 });
    doc.text('Status', 450, payTableTop, { width: 80 });

    doc.moveTo(50, payTableTop + 15).lineTo(530, payTableTop + 15).stroke();

    let py = payTableTop + 20;

    data.payments.forEach((payment) => {
      if (py > 700) {
        doc.addPage();
        py = 50;
      }

      doc.text(payment.transactionRef, 50, py, { width: 120 });
      doc.text(formatCurrency(payment.amount), 180, py, { width: 80 });
      doc.text(payment.paymentMethod, 270, py, { width: 80 });
      doc.text(payment.paymentDate ? new Date(payment.paymentDate).toLocaleDateString() : '-', 360, py, { width: 80 });
      doc.text(payment.status, 450, py, { width: 80 });

      py += 18;
    });
  }

  // Footer
  doc.fontSize(8);
  const bottomY = doc.page.height - 50;
  doc.text(
    'This is a computer-generated statement. For any queries, please contact customer support.',
    50,
    bottomY,
    { align: 'center' }
  );

  return doc;
}

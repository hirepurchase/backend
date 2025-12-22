import nodemailer from 'nodemailer';
import axios from 'axios';

// Email configuration
const emailPort = parseInt(process.env.EMAIL_PORT || '587');
const emailConfig = {
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: emailPort,
  secure: emailPort === 465, // true for port 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false, // Allow self-signed certificates
  },
};

const emailTransporter = nodemailer.createTransport(emailConfig);

// Verify email configuration on startup
if (process.env.ENABLE_EMAIL_NOTIFICATIONS === 'true' && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
  emailTransporter.verify((error, success) => {
    if (error) {
      console.error('❌ Email server connection failed:', error.message);
      console.error('Please check your email credentials in .env file');
    } else {
      console.log('✅ Email server is ready to send messages');
    }
  });
}

// Nalo SMS configuration
const naloConfig = {
  apiUrl: process.env.NALO_API_URL || 'https://api.nalosolutions.com/sms/v1/text/single',
  apiKey: process.env.NALO_API_KEY,
  senderId: process.env.NALO_SENDER_ID || 'HIREPURCHASE',
};

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SMSOptions {
  to: string;
  message: string;
}

// Send Email
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  if (process.env.ENABLE_EMAIL_NOTIFICATIONS !== 'true') {
    console.log('Email notifications are disabled');
    return false;
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.warn('Email credentials not configured. Skipping email send.');
    return false;
  }

  try {
    const info = await emailTransporter.sendMail({
      from: process.env.EMAIL_FROM || 'Hire Purchase System <noreply@hirepurchase.com>',
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });

    console.log('Email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// Send SMS using Nalo
export async function sendSMS(options: SMSOptions): Promise<boolean> {
  if (process.env.ENABLE_SMS_NOTIFICATIONS !== 'true') {
    console.log('SMS notifications are disabled');
    return false;
  }

  if (!naloConfig.apiKey) {
    console.warn('Nalo SMS API key not configured. Skipping SMS send.');
    return false;
  }

  try {
    const response = await axios.post(
      naloConfig.apiUrl,
      {
        key: naloConfig.apiKey,
        msisdn: options.to,
        message: options.message,
        sender_id: naloConfig.senderId,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('SMS sent via Nalo:', response.data);
    return true;
  } catch (error) {
    console.error('Error sending SMS via Nalo:', error);
    return false;
  }
}

// Customer Welcome Notification
export async function sendWelcomeNotification(customerData: {
  firstName: string;
  lastName: string;
  email?: string;
  phone: string;
  membershipId: string;
  customerId: string;
}): Promise<void> {
  const { firstName, lastName, email, phone, membershipId, customerId } = customerData;

  // Email template
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #1e40af; color: white; padding: 20px; text-align: center; }
        .content { padding: 30px 20px; background-color: #f9fafb; }
        .info-box { background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
        .info-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #6b7280; }
        .value { color: #1f2937; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to Hire Purchase System!</h1>
        </div>
        <div class="content">
          <h2>Hello ${firstName} ${lastName},</h2>
          <p>Welcome to our Hire Purchase System! We're excited to have you as a valued customer.</p>

          <div class="info-box">
            <h3>Your Account Details</h3>
            <div class="info-row">
              <span class="label">Customer ID:</span>
              <span class="value">${customerId}</span>
            </div>
            <div class="info-row">
              <span class="label">Membership ID:</span>
              <span class="value">${membershipId}</span>
            </div>
            <div class="info-row">
              <span class="label">Phone:</span>
              <span class="value">${phone}</span>
            </div>
            ${email ? `
            <div class="info-row">
              <span class="label">Email:</span>
              <span class="value">${email}</span>
            </div>
            ` : ''}
          </div>

          <p>Please keep your Membership ID safe as you'll need it for all future transactions.</p>

          <p>If you have any questions or need assistance, please don't hesitate to contact us.</p>

          <p>Best regards,<br>Hire Purchase Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message. Please do not reply to this email.</p>
          <p>&copy; ${new Date().getFullYear()} Hire Purchase System. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const emailText = `
Welcome to Hire Purchase System!

Hello ${firstName} ${lastName},

Welcome to our Hire Purchase System! We're excited to have you as a valued customer.

Your Account Details:
- Customer ID: ${customerId}
- Membership ID: ${membershipId}
- Phone: ${phone}
${email ? `- Email: ${email}` : ''}

Please keep your Membership ID safe as you'll need it for all future transactions.

If you have any questions or need assistance, please don't hesitate to contact us.

Best regards,
Hire Purchase Team
  `;

  // SMS message
  const smsMessage = `Welcome to Hire Purchase! Your Membership ID: ${membershipId}. Customer ID: ${customerId}. Keep this safe for future transactions.`;

  // Send notifications
  const promises: Promise<boolean>[] = [];

  if (email) {
    promises.push(
      sendEmail({
        to: email,
        subject: 'Welcome to Hire Purchase System!',
        html: emailHtml,
        text: emailText,
      })
    );
  }

  promises.push(
    sendSMS({
      to: phone,
      message: smsMessage,
    })
  );

  await Promise.allSettled(promises);
}

// Contract Confirmation Notification
export async function sendContractConfirmation(contractData: {
  customerFirstName: string;
  customerLastName: string;
  customerEmail?: string;
  customerPhone: string;
  contractNumber: string;
  contractId: string;
  productName: string;
  totalPrice: number;
  depositAmount: number;
  installmentAmount: number;
  totalInstallments: number;
  paymentFrequency: string;
  startDate: Date;
  endDate: Date;
}): Promise<void> {
  const {
    customerFirstName,
    customerLastName,
    customerEmail,
    customerPhone,
    contractNumber,
    contractId,
    productName,
    totalPrice,
    depositAmount,
    installmentAmount,
    totalInstallments,
    paymentFrequency,
    startDate,
    endDate,
  } = contractData;

  const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`;
  const formatDate = (date: Date) => new Date(date).toLocaleDateString('en-GB');

  // Email template
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #059669; color: white; padding: 20px; text-align: center; }
        .content { padding: 30px 20px; background-color: #f9fafb; }
        .info-box { background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
        .info-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #6b7280; }
        .value { color: #1f2937; }
        .highlight { background-color: #dbeafe; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center; }
        .highlight h2 { margin: 0; color: #1e40af; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Contract Confirmed!</h1>
        </div>
        <div class="content">
          <h2>Hello ${customerFirstName} ${customerLastName},</h2>
          <p>Your hire purchase contract has been successfully created and confirmed.</p>

          <div class="highlight">
            <h2>Contract #${contractNumber}</h2>
          </div>

          <div class="info-box">
            <h3>Contract Details</h3>
            <div class="info-row">
              <span class="label">Product:</span>
              <span class="value">${productName}</span>
            </div>
            <div class="info-row">
              <span class="label">Total Price:</span>
              <span class="value">${formatCurrency(totalPrice)}</span>
            </div>
            <div class="info-row">
              <span class="label">Deposit Amount:</span>
              <span class="value">${formatCurrency(depositAmount)}</span>
            </div>
            <div class="info-row">
              <span class="label">Installment Amount:</span>
              <span class="value">${formatCurrency(installmentAmount)}</span>
            </div>
            <div class="info-row">
              <span class="label">Total Installments:</span>
              <span class="value">${totalInstallments}</span>
            </div>
            <div class="info-row">
              <span class="label">Payment Frequency:</span>
              <span class="value">${paymentFrequency}</span>
            </div>
            <div class="info-row">
              <span class="label">Start Date:</span>
              <span class="value">${formatDate(startDate)}</span>
            </div>
            <div class="info-row">
              <span class="label">End Date:</span>
              <span class="value">${formatDate(endDate)}</span>
            </div>
          </div>

          <p><strong>Important:</strong> Please ensure timely payment of installments to avoid penalties.</p>

          <p>If you have any questions about your contract, please contact us with your Contract Number: <strong>${contractNumber}</strong></p>

          <p>Best regards,<br>Hire Purchase Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message. Please do not reply to this email.</p>
          <p>&copy; ${new Date().getFullYear()} Hire Purchase System. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const emailText = `
Contract Confirmed!

Hello ${customerFirstName} ${customerLastName},

Your hire purchase contract has been successfully created and confirmed.

Contract #${contractNumber}

Contract Details:
- Product: ${productName}
- Total Price: ${formatCurrency(totalPrice)}
- Deposit Amount: ${formatCurrency(depositAmount)}
- Installment Amount: ${formatCurrency(installmentAmount)}
- Total Installments: ${totalInstallments}
- Payment Frequency: ${paymentFrequency}
- Start Date: ${formatDate(startDate)}
- End Date: ${formatDate(endDate)}

Important: Please ensure timely payment of installments to avoid penalties.

If you have any questions about your contract, please contact us with your Contract Number: ${contractNumber}

Best regards,
Hire Purchase Team
  `;

  // SMS message
  const smsMessage = `Contract ${contractNumber} confirmed! Product: ${productName}. Total: ${formatCurrency(totalPrice)}. Installment: ${formatCurrency(installmentAmount)} x ${totalInstallments} (${paymentFrequency}). Start: ${formatDate(startDate)}.`;

  // Send notifications
  const promises: Promise<boolean>[] = [];

  if (customerEmail) {
    promises.push(
      sendEmail({
        to: customerEmail,
        subject: `Contract Confirmed - ${contractNumber}`,
        html: emailHtml,
        text: emailText,
      })
    );
  }

  promises.push(
    sendSMS({
      to: customerPhone,
      message: smsMessage,
    })
  );

  await Promise.allSettled(promises);
}

// Payment Reminder Notification
export async function sendPaymentReminder(reminderData: {
  customerFirstName: string;
  customerLastName: string;
  customerEmail?: string;
  customerPhone: string;
  customerId: string;
  contractNumber: string;
  contractId: string;
  installmentId: string;
  installmentNumber: number;
  amount: number;
  dueDate: Date;
  daysUntilDue?: number;
}): Promise<void> {
  const {
    customerFirstName,
    customerLastName,
    customerEmail,
    customerPhone,
    customerId,
    contractNumber,
    contractId,
    installmentId,
    installmentNumber,
    amount,
    dueDate,
    daysUntilDue,
  } = reminderData;

  const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`;
  const formatDate = (date: Date) => new Date(date).toLocaleDateString('en-GB');

  // SMS message
  const smsMessage = `Payment Reminder: Installment #${installmentNumber} for Contract ${contractNumber} of ${formatCurrency(amount)} is due on ${formatDate(dueDate)}. ${daysUntilDue !== undefined ? `Due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}.` : ''} Please pay on time to avoid penalties.`;

  // Send notifications
  const promises: Promise<boolean>[] = [];

  if (customerEmail) {
    promises.push(
      sendEmail({
        to: customerEmail,
        subject: `Payment Reminder - ${contractNumber}`,
        text: smsMessage,
        html: `<p>${smsMessage}</p>`,
      })
    );
  }

  promises.push(
    sendSMS({
      to: customerPhone,
      message: smsMessage,
    })
  );

  await Promise.allSettled(promises);
}

// Overdue Payment Notification
export async function sendOverdueNotification(overdueData: {
  customerFirstName: string;
  customerLastName: string;
  customerEmail?: string;
  customerPhone: string;
  customerId: string;
  contractNumber: string;
  contractId: string;
  installmentId: string;
  installmentNumber: number;
  amount: number;
  paidAmount: number;
  dueDate: Date;
  daysOverdue: number;
  penaltyAmount?: number;
}): Promise<void> {
  const {
    customerFirstName,
    customerLastName,
    customerEmail,
    customerPhone,
    customerId,
    contractNumber,
    contractId,
    installmentId,
    installmentNumber,
    amount,
    paidAmount,
    dueDate,
    daysOverdue,
    penaltyAmount,
  } = overdueData;

  const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`;
  const formatDate = (date: Date) => new Date(date).toLocaleDateString('en-GB');
  const remainingAmount = amount - paidAmount;

  // SMS message
  const smsMessage = `OVERDUE NOTICE: Installment #${installmentNumber} for Contract ${contractNumber} is ${daysOverdue} days overdue. Amount: ${formatCurrency(remainingAmount)}${penaltyAmount ? ` + Penalty: ${formatCurrency(penaltyAmount)}` : ''}. Please pay immediately to avoid further penalties.`;

  // Send notifications
  const promises: Promise<boolean>[] = [];

  if (customerEmail) {
    promises.push(
      sendEmail({
        to: customerEmail,
        subject: `⚠️ OVERDUE PAYMENT - ${contractNumber}`,
        text: smsMessage,
        html: `<p style="color: red; font-weight: bold;">${smsMessage}</p>`,
      })
    );
  }

  promises.push(
    sendSMS({
      to: customerPhone,
      message: smsMessage,
    })
  );

  await Promise.allSettled(promises);
}

// Payment Failure Notification
export async function sendPaymentFailureNotification(failureData: {
  customerFirstName: string;
  customerLastName: string;
  customerEmail?: string;
  customerPhone: string;
  customerId: string;
  contractNumber: string;
  contractId: string;
  amount: number;
  failureReason: string;
  transactionRef: string;
  nextRetryDate?: Date;
}): Promise<void> {
  const {
    customerFirstName,
    customerLastName,
    customerEmail,
    customerPhone,
    customerId,
    contractNumber,
    contractId,
    amount,
    failureReason,
    transactionRef,
    nextRetryDate,
  } = failureData;

  const formatCurrency = (amount: number) => `GHS ${amount.toFixed(2)}`;
  const formatDate = (date: Date) => new Date(date).toLocaleDateString('en-GB');

  // SMS message
  const smsMessage = `Dear ${customerFirstName} ${customerLastName}, your payment of ${formatCurrency(amount)} for Contract ${contractNumber} failed due to ${failureReason}. ${nextRetryDate ? `We will retry on ${formatDate(nextRetryDate)}.` : ''} Please ensure you have sufficient balance. Ref: ${transactionRef}`;

  // Email template
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #dc2626; color: white; padding: 20px; text-align: center; }
        .content { padding: 30px 20px; background-color: #f9fafb; }
        .info-box { background-color: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; }
        .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
        .info-row:last-child { border-bottom: none; }
        .label { font-weight: bold; color: #6b7280; }
        .value { color: #1f2937; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Payment Failed</h1>
        </div>
        <div class="content">
          <h2>Hello ${customerFirstName} ${customerLastName},</h2>
          <p>We attempted to process your payment but it was unsuccessful.</p>

          <div class="warning-box">
            <strong>⚠️ Action Required:</strong> Please ensure you have sufficient balance in your mobile money account for the next retry attempt.
          </div>

          <div class="info-box">
            <h3>Payment Details</h3>
            <div class="info-row">
              <span class="label">Contract Number:</span>
              <span class="value">${contractNumber}</span>
            </div>
            <div class="info-row">
              <span class="label">Amount:</span>
              <span class="value">${formatCurrency(amount)}</span>
            </div>
            <div class="info-row">
              <span class="label">Failure Reason:</span>
              <span class="value">${failureReason}</span>
            </div>
            <div class="info-row">
              <span class="label">Transaction Reference:</span>
              <span class="value">${transactionRef}</span>
            </div>
            ${nextRetryDate ? `
            <div class="info-row">
              <span class="label">Next Retry Date:</span>
              <span class="value">${formatDate(nextRetryDate)}</span>
            </div>
            ` : ''}
          </div>

          <p><strong>What to do next:</strong></p>
          <ul>
            <li>Ensure you have at least ${formatCurrency(amount)} in your mobile money account</li>
            <li>Check your mobile money account status</li>
            ${nextRetryDate ? `<li>We will automatically retry the payment on ${formatDate(nextRetryDate)}</li>` : '<li>Contact us if you need assistance</li>'}
          </ul>

          <p>If you have any questions, please contact us immediately with your Contract Number: <strong>${contractNumber}</strong></p>

          <p>Best regards,<br>Hire Purchase Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message. Please do not reply to this email.</p>
          <p>&copy; ${new Date().getFullYear()} Hire Purchase System. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const emailText = `
Payment Failed

Hello ${customerFirstName} ${customerLastName},

We attempted to process your payment but it was unsuccessful.

⚠️ Action Required: Please ensure you have sufficient balance in your mobile money account for the next retry attempt.

Payment Details:
- Contract Number: ${contractNumber}
- Amount: ${formatCurrency(amount)}
- Failure Reason: ${failureReason}
- Transaction Reference: ${transactionRef}
${nextRetryDate ? `- Next Retry Date: ${formatDate(nextRetryDate)}` : ''}

What to do next:
- Ensure you have at least ${formatCurrency(amount)} in your mobile money account
- Check your mobile money account status
${nextRetryDate ? `- We will automatically retry the payment on ${formatDate(nextRetryDate)}` : '- Contact us if you need assistance'}

If you have any questions, please contact us immediately with your Contract Number: ${contractNumber}

Best regards,
Hire Purchase Team
  `;

  // Send notifications
  const promises: Promise<boolean>[] = [];

  if (customerEmail) {
    promises.push(
      sendEmail({
        to: customerEmail,
        subject: `⚠️ Payment Failed - ${contractNumber}`,
        html: emailHtml,
        text: emailText,
      })
    );
  }

  promises.push(
    sendSMS({
      to: customerPhone,
      message: smsMessage,
    })
  );

  await Promise.allSettled(promises);
}

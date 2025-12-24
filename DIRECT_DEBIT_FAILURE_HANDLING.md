# Direct Debit Failure Handling System

## Overview

When a Hubtel direct debit payment fails due to insufficient funds or other reasons, the system has a comprehensive automatic retry mechanism with customer notifications.

---

## How It Works

### 1. **Payment Initiation**
When an installment is due, the system initiates a direct debit charge via Hubtel API:
- **Location**: [backend/src/services/hubtelService.ts](backend/src/services/hubtelService.ts) - `chargeDirectDebitPayment()`
- The charge is sent to the customer's mobile money account
- No customer action required (money is automatically deducted)

### 2. **Hubtel Callback Processing**
Hubtel sends a webhook callback with the payment result:
- **Location**: [backend/src/services/hubtelService.ts](backend/src/services/hubtelService.ts:453-580) - `processHubtelCallback()`

**Response Codes:**
- `0000` = Payment successful
- `2001` = Payment failed (usually insufficient funds or customer rejection)
- Other codes = Various failure reasons

### 3. **Failure Detection**
When response code is `2001`, the system:
```typescript
if (ResponseCode === '2001') {
  paymentStatus = 'FAILED';
  failureReason = Data?.Description || 'Payment failed - insufficient funds or customer rejection';
}
```

The payment record is updated with:
- Status: `FAILED`
- Failure reason stored
- Next retry date calculated
- Retry count incremented

---

## Automatic Retry System

### Configuration
**Location**: [backend/src/services/paymentRetryService.ts](backend/src/services/paymentRetryService.ts:10-31)

**Default Settings:**
```javascript
{
  enableAutoRetry: true,              // Enable automatic retries
  maxRetryAttempts: 3,                // Maximum 3 retry attempts
  retryIntervalHours: 24,             // 24 hours between attempts
  retrySchedule: '1,3,7',             // Retry on day 1, day 3, and day 7
  notifyOnFailure: true,              // Notify admin on failure
  notifyCustomerOnFailure: true,      // Notify customer on failure
  sendSMSOnFailure: true,             // Send SMS to customer
  failureSMSTemplate: 'Dear {customerName}, your payment of GHS {amount} failed...'
}
```

### Retry Schedule Explained

If a payment fails on **Monday**:

1. **First Retry**: Tuesday (1 day later)
2. **Second Retry**: Thursday (3 days from original failure)
3. **Third Retry**: Following Monday (7 days from original failure)

After 3 failed attempts, auto-retry stops and admin intervention is required.

### How Retry Works

**Location**: [backend/src/services/paymentRetryService.ts](backend/src/services/paymentRetryService.ts:117-260) - `retryPayment()`

1. **Check Eligibility**:
   - Payment status must be `FAILED`
   - Retry count < max attempts (3)
   - Next retry date has arrived

2. **Create Retry Attempt**:
   - Record created in `PaymentRetry` table
   - Tracks attempt number and result

3. **Initiate New Charge**:
   ```typescript
   if (payment.contract.paymentMethod === 'HUBTEL_DIRECT_DEBIT') {
     result = await initiateDirectDebitCharge({
       amount: payment.amount,
       customerPhone: payment.contract.mobileMoneyNumber,
       transactionRef: `${payment.transactionRef}-retry-${newRetryCount}`,
       // ... other params
     });
   }
   ```

4. **Update Records**:
   - Payment retry count incremented
   - Next retry date calculated
   - Payment status updated based on result

---

## Customer Notifications

### Failure Notification
**Location**: [backend/src/services/hubtelService.ts](backend/src/services/hubtelService.ts:542-576)

When payment fails, customer receives SMS:
```
Dear {customerName}, your payment of GHS {amount} failed due to
insufficient funds. Please ensure you have enough balance for the
next retry.
```

**Template Variables:**
- `{customerName}`: Customer's full name
- `{amount}`: Payment amount
- `{contractNumber}`: Contract reference
- `{nextRetryDate}`: When next retry will occur

### Success Notification
When retry succeeds, customer receives:
```
Dear {customerName}, your payment of GHS {amount} for contract
{contractNumber} has been successfully processed.
```

---

## Admin Features

### 1. **Failed Payments Dashboard**
**Location**: `/admin/failed-payments`

Shows all failed payments with:
- Customer details
- Failure reason
- Retry count (e.g., "2/3")
- Next retry date
- Manual retry button

### 2. **Retry Settings**
**Location**: `/admin/settings/retry-settings`

Admins can configure:
- Enable/disable auto-retry
- Maximum retry attempts
- Retry schedule (days between attempts)
- Notification settings
- SMS template customization

### 3. **Manual Retry**
Admins can manually trigger retry for any failed payment:
- Click "Retry Now" button
- System bypasses retry schedule
- Attempts payment immediately

---

## Database Tracking

### PaymentTransaction Table
```sql
{
  status: 'FAILED',
  failureReason: 'Insufficient funds',
  retryCount: 2,                    -- Current retry attempt
  nextRetryAt: '2025-01-15 14:00',  -- When next retry will occur
  isAutoRetryEnabled: true
}
```

### PaymentRetry Table
Tracks each retry attempt:
```sql
{
  paymentId: 'xxx',
  attemptNumber: 1,
  status: 'FAILED',
  responseCode: '2001',
  responseMessage: 'Insufficient funds',
  retriedAt: '2025-01-12 14:00'
}
```

---

## Workflow Diagram

```
Customer's Direct Debit Payment Due
         ↓
System Initiates Charge via Hubtel
         ↓
Customer Account Has Insufficient Funds
         ↓
Hubtel Returns: ResponseCode='2001'
         ↓
System Receives Callback
         ↓
┌─────────────────────────────────┐
│  Payment Status: FAILED         │
│  Failure Reason: Insufficient   │
│  Retry Count: 0 → 1             │
│  Next Retry: +1 day             │
└─────────────────────────────────┘
         ↓
Customer Receives SMS Notification
"Payment failed - ensure balance for next retry"
         ↓
Admin Sees Failed Payment in Dashboard
         ↓
[Wait 1 day]
         ↓
Automatic Retry #1
         ↓
    Still Fails?
    ┌───┴───┐
   YES     NO
    │       └──→ SUCCESS → Update Contract
    ↓
Retry Count: 1 → 2
Next Retry: +3 days from original
    ↓
[Wait until day 3]
    ↓
Automatic Retry #2
    ↓
    Still Fails?
    ┌───┴───┐
   YES     NO
    │       └──→ SUCCESS → Update Contract
    ↓
Retry Count: 2 → 3
Next Retry: +7 days from original
    ↓
[Wait until day 7]
    ↓
Final Automatic Retry #3
    ↓
    Still Fails?
    ┌───┴───┐
   YES     NO
    │       └──→ SUCCESS → Update Contract
    ↓
Max Retries Reached
Auto-Retry Disabled
    ↓
Admin Must:
- Contact Customer
- Or Manual Retry
- Or Mark as Defaulter
```

---

## Common Failure Scenarios

### 1. **Insufficient Funds**
- **Reason**: Customer doesn't have enough money
- **Action**:
  - System retries automatically per schedule
  - Customer notified to fund account
  - After 3 failures, admin intervention required

### 2. **Account Blocked/Frozen**
- **Reason**: Mobile money account is blocked
- **Action**:
  - Auto-retries will keep failing
  - Admin should contact customer
  - Customer must resolve account issues

### 3. **Network Issues**
- **Reason**: Telecom network problems
- **Action**:
  - Usually transient - retry often succeeds
  - System automatically retries

### 4. **Customer Declined**
- **Reason**: Customer manually rejected the charge
- **Action**:
  - Treated same as insufficient funds
  - Admin may need to follow up

---

## Best Practices

### For Admins:

1. **Monitor Failed Payments Dashboard Daily**
   - Check for patterns (same customer failing repeatedly)
   - Identify customers who need contact

2. **Customize SMS Templates**
   - Clear, friendly language
   - Include support contact
   - Mention next retry date

3. **Adjust Retry Schedule**
   - Consider payday cycles
   - Monthly salary dates
   - Weekly income patterns

4. **Follow Up After Max Retries**
   - Call customer to understand issue
   - Offer payment plan adjustment
   - Consider contract renegotiation

### For Customers:

1. **Keep Sufficient Balance**
   - Maintain funds before due date
   - Consider auto-savings for installments

2. **Preapproval is Key**
   - Ensure direct debit mandate is active
   - Don't cancel preapproval without notice

3. **Notify Admin of Issues**
   - If changing phone number
   - If account problems arise
   - If payment schedule needs adjustment

---

## API Endpoints

### Check Payment Status
```
GET /api/payments/status/:transactionRef
```

### Manual Retry
```
POST /api/payments/:paymentId/retry
```

### Get Retry Settings
```
GET /api/settings/retry
```

### Update Retry Settings
```
PUT /api/settings/retry
```

---

## Troubleshooting

### Payment Stuck in PENDING
- **Cause**: Callback not received from Hubtel
- **Solution**: Manually check status via Hubtel API
- **Location**: `/admin/failed-payments` → Check Status button

### Retries Not Happening
- **Check**: Retry settings enabled?
- **Check**: Next retry date in future?
- **Check**: Cron job running?
- **Check**: Max retries not exceeded?

### Customer Not Receiving Notifications
- **Check**: SMS service configured?
- **Check**: Customer phone number correct?
- **Check**: Notification settings enabled?
- **Location**: `/admin/settings/notifications`

---

## Technical Implementation

### Retry Cron Job
**Location**: [backend/src/index.ts](backend/src/index.ts)

Runs every hour to process pending retries:
```typescript
cron.schedule('0 * * * *', async () => {
  const paymentsToRetry = await getPaymentsForRetry();
  for (const payment of paymentsToRetry) {
    await retryPayment(payment.id);
  }
});
```

### Database Indexes
For performance, indexes on:
- `PaymentTransaction.status`
- `PaymentTransaction.nextRetryAt`
- `PaymentTransaction.retryCount`

---

## Summary

The system provides **robust, automatic handling** of direct debit failures:

✅ **Automatic Detection**: Identifies failures instantly
✅ **Smart Retries**: 3 attempts over 7 days
✅ **Customer Notifications**: SMS alerts on each failure
✅ **Admin Dashboard**: Complete visibility of all failures
✅ **Manual Override**: Admins can force retry anytime
✅ **Configurable**: All settings customizable
✅ **Audit Trail**: Complete history of all retry attempts

This ensures maximum payment collection while maintaining good customer experience.

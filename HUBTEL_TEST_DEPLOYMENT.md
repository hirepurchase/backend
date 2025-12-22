# Hubtel Test Page Deployment Guide

## Overview
The Hubtel Test Page allows you to test all Hubtel payment functionalities from a single interface.

## Files Created

### Backend
1. `backend/src/controllers/hubtelTestController.ts` - Test controller with 10 endpoints
2. `backend/src/routes/hubtelTest.ts` - Test routes
3. `backend/src/routes/index.ts` - Updated to include test routes

### Frontend
1. `frontend/src/app/admin/hubtel-test/page.tsx` - Test page UI
2. `frontend/src/components/admin/Sidebar.tsx` - Updated with "Hubtel Test" menu item

## Deployment Steps

### 1. Backend Deployment (DigitalOcean App Platform)

Your backend is deployed at: `https://hirepurchase-tt5mv.ondigitalocean.app`

**Option A: Automatic Deployment (If connected to GitHub)**
- Push your changes to GitHub
- DigitalOcean will automatically rebuild and deploy

**Option B: Manual Deployment**
```bash
cd /home/wilsonjunior/Documents/hirepurchase/backend
npm run build
# Upload dist folder to DigitalOcean or trigger manual deployment
```

### 2. Frontend Deployment

Your frontend needs to be redeployed with the new test page.

```bash
cd /home/wilsonjunior/Documents/hirepurchase/frontend
npm run build
# Deploy to your hosting provider
```

### 3. Hubtel IP Whitelisting

**CRITICAL**: Hubtel requires your server IP to be whitelisted before API calls will work.

#### Get Your Server IP Addresses

**Development (Local):**
- IP: `154.161.60.133` (already provided)

**Production (DigitalOcean):**
To find your DigitalOcean App Platform outbound IP:

1. Go to your DigitalOcean dashboard
2. Navigate to your App
3. Go to Settings → Networking
4. Look for "Outbound IP Addresses" or "Static IP"

OR run this on your server:
```bash
curl -s ifconfig.me
```

#### Submit to Hubtel

Contact Hubtel support and provide them with:

**Email Template:**
```
Subject: IP Whitelisting Request for API Access

Hello Hubtel Team,

Please whitelist the following IP addresses for API access:

Merchant/Business Name: [Your Business Name]
POS Sales ID: 2036849

IP Addresses to Whitelist:
- Development: 154.161.60.133
- Production: [Your DigitalOcean IP]

API Endpoints Required:
1. https://rmp.hubtel.com/merchantaccount/merchants/*/receive/mobilemoney
2. https://api-txnstatus.hubtel.com/transactions/*/status
3. https://preapproval.hubtel.com/api/v2/merchant/*/preapproval/*

Thank you.
```

### 4. Environment Variables

Ensure these are set in your production environment:

```env
HUBTEL_POS_SALES_ID=2036849
HUBTEL_API_KEY=2ca96dc539e84b158d477b346e87db1f
HUBTEL_API_SECRET=nrLLn5P
HUBTEL_CALLBACK_URL=https://hirepurchase-tt5mv.ondigitalocean.app/api/payments/hubtel/callback
```

### 5. Verify Deployment

After deployment, verify the endpoints are accessible:

```bash
# Test health check
curl https://hirepurchase-tt5mv.ondigitalocean.app/api/health

# Test if hubtel-test routes are loaded (requires authentication)
curl https://hirepurchase-tt5mv.ondigitalocean.app/api/hubtel-test/customers
```

## Using the Test Page

### Access
1. Login as Admin
2. Navigate to **Admin → Hubtel Test** in the sidebar

### Testing Workflow

#### 1. Regular Payment (Receive Money)
- Select "Receive Money" tab
- Enter amount, phone number, and select network
- Click "Initiate Receive Money"
- Customer receives prompt on their phone
- Check status in "Check Status" tab

#### 2. Direct Debit Setup (Preapproval)
- Select "Preapproval" tab
- Select customer and network (MTN, Vodafone, or Telecel only)
- Click "Initiate Preapproval"
- **If USSD**: Customer dials USSD code to approve
- **If OTP**: Enter OTP in verification form
- Check status to confirm approval

#### 3. Direct Debit Charge
- Ensure customer has approved preapproval first
- Select "Direct Debit" tab
- Enter amount and customer phone
- Click "Initiate Direct Debit Charge"
- Payment deducted automatically (no customer action required)

#### 4. Check Status
- Select "Check Status" tab
- Enter transaction reference or client reference ID
- View detailed status from both local database and Hubtel

## Troubleshooting

### Error: 500 Internal Server Error
**Possible Causes:**
1. Backend not deployed yet
2. IP not whitelisted by Hubtel
3. Invalid Hubtel credentials
4. Network connectivity issues

**Solutions:**
- Check server logs for detailed error
- Verify deployment completed successfully
- Confirm IP whitelisting with Hubtel
- Test Hubtel credentials manually

### Error: "Customer has not approved Direct Debit"
**Solution:** Complete preapproval process first before attempting direct debit charge

### Error: "Invalid network"
**Solution:**
- Regular payments support: MTN, Vodafone, Telecel, AirtelTigo
- Direct Debit only supports: MTN, Vodafone, Telecel

### Error: Module not found
**Solution:** Ensure all dependencies are installed:
```bash
npm install
```

## API Endpoints Reference

All endpoints require admin authentication.

### Get Test Data
- `GET /api/hubtel-test/customers` - List of customers
- `GET /api/hubtel-test/contracts` - Active contracts
- `GET /api/hubtel-test/preapprovals` - All preapprovals
- `GET /api/hubtel-test/payments` - Recent Hubtel payments

### Test Operations
- `POST /api/hubtel-test/receive-money` - Test regular payment
- `POST /api/hubtel-test/preapproval/initiate` - Setup direct debit
- `POST /api/hubtel-test/preapproval/verify-otp` - Verify OTP
- `GET /api/hubtel-test/preapproval/:clientReferenceId` - Check preapproval
- `POST /api/hubtel-test/preapproval/cancel` - Cancel preapproval
- `POST /api/hubtel-test/preapproval/reactivate` - Reactivate preapproval
- `POST /api/hubtel-test/direct-debit/charge` - Charge via direct debit
- `GET /api/hubtel-test/payment/:transactionRef` - Check payment status

## Security Notes

1. **Admin Only**: All test endpoints require admin authentication
2. **Production Use**: This is for testing only - consider restricting access in production
3. **Sensitive Data**: Test page displays transaction references and status - ensure proper access control
4. **Rate Limiting**: Hubtel may have rate limits - avoid excessive testing

## Support

If you encounter issues:

1. Check backend logs: `pm2 logs` or DigitalOcean logs
2. Verify Hubtel API credentials
3. Confirm IP whitelisting status
4. Test with small amounts first (GHS 1.00)

## Hubtel API Documentation

For reference:
- [Hubtel Receive Money API](https://developers.hubtel.com/documentations/receive-money)
- [Hubtel Direct Debit API](https://developers.hubtel.com/documentations/direct-debit)
- [Hubtel Payment Status API](https://developers.hubtel.com/documentations/payment-status)

## Summary of Hubtel APIs Used

### 1. Receive Money (Regular Payments)
- **URL**: `https://rmp.hubtel.com/merchantaccount/merchants/{MERCHANT_ID}/receive/mobilemoney`
- **Method**: POST
- **Networks**: MTN, Vodafone, Telecel, AirtelTigo

### 2. Transaction Status
- **URL**: `https://api-txnstatus.hubtel.com/transactions/{MERCHANT_ID}/status`
- **Method**: GET

### 3. Preapproval Initiate
- **URL**: `https://preapproval.hubtel.com/api/v2/merchant/{MERCHANT_ID}/preapproval/initiate`
- **Method**: POST
- **Networks**: MTN, Vodafone, Telecel (Direct Debit only)

### 4. Preapproval Verify OTP
- **URL**: `https://preapproval.hubtel.com/api/v2/merchant/{MERCHANT_ID}/preapproval/verifyotp`
- **Method**: POST

### 5. Preapproval Status
- **URL**: `https://preapproval.hubtel.com/api/v2/merchant/{MERCHANT_ID}/preapproval/{clientReferenceId}/status`
- **Method**: GET

### 6. Cancel Preapproval
- **URL**: `https://preapproval.hubtel.com/api/v2/merchant/{MERCHANT_ID}/preapproval/{customerMsisdn}/cancel`
- **Method**: GET

### 7. Reactivate Preapproval
- **URL**: `https://preapproval.hubtel.com/api/v2/merchant/{MERCHANT_ID}/preapproval/reactivate`
- **Method**: POST

---

**All APIs require Basic Authentication using HUBTEL_API_KEY and HUBTEL_API_SECRET**

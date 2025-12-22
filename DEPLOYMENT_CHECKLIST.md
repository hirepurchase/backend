# Quick Deployment Checklist for Hubtel Test Page

## ✅ Pre-Deployment Checklist

### 1. Get Production Server IP
```bash
# SSH into your DigitalOcean server or run in production environment
curl -s ifconfig.me
```
**Your IPs:**
- Development: `154.161.60.133`
- Production: `[Get from DigitalOcean]`

### 2. Contact Hubtel for IP Whitelisting
Email Hubtel support with:
- Subject: "IP Whitelisting Request for API Access"
- POS Sales ID: `2036849`
- IPs to whitelist: Development + Production IPs
- Required API endpoints (see HUBTEL_TEST_DEPLOYMENT.md)

### 3. Verify Environment Variables on Production
Ensure these are set in DigitalOcean:
```
HUBTEL_POS_SALES_ID=2036849
HUBTEL_API_KEY=2ca96dc539e84b158d477b346e87db1f
HUBTEL_API_SECRET=nrLLn5P
HUBTEL_CALLBACK_URL=https://hirepurchase-tt5mv.ondigitalocean.app/api/payments/hubtel/callback
```

## 🚀 Deployment Steps

### Backend (DigitalOcean)

**If using GitHub auto-deployment:**
```bash
cd /home/wilsonjunior/Documents/hirepurchase
git add .
git commit -m "Add Hubtel test page functionality"
git push origin main
```

**Manual deployment:**
1. Build locally: `cd backend && npm run build`
2. Upload to DigitalOcean or trigger manual deployment

### Frontend

**Deploy frontend:**
```bash
cd /home/wilsonjunior/Documents/hirepurchase/frontend
npm run build
# Upload .next folder to your hosting provider
```

## 🧪 Testing After Deployment

### 1. Check Backend Health
```bash
curl https://hirepurchase-tt5mv.ondigitalocean.app/api/health
```
Expected: `{"status":"ok","timestamp":"..."}`

### 2. Test Authentication (with your admin token)
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://hirepurchase-tt5mv.ondigitalocean.app/api/hubtel-test/customers
```

### 3. Access Test Page
1. Login as Admin
2. Navigate to: **Admin → Hubtel Test**
3. Try a small test payment (GHS 1.00)

## ⚠️ Known Issues & Solutions

### Issue: 500 Error on Test Page
**Causes:**
- ✗ Backend not deployed yet
- ✗ IP not whitelisted by Hubtel
- ✗ Invalid credentials

**Solution:**
1. Check deployment status in DigitalOcean
2. Verify IP whitelisting with Hubtel
3. Check backend logs for specific error

### Issue: "Module not found" Error
**Solution:**
```bash
cd backend
npm install
npm run build
```

### Issue: Cannot access test page
**Solution:**
- Ensure you're logged in as Admin
- Check Sidebar has "Hubtel Test" menu item
- Clear browser cache and refresh

## 📋 Current Status

### Files Modified:
- ✅ `backend/src/controllers/hubtelTestController.ts` (Created)
- ✅ `backend/src/routes/hubtelTest.ts` (Created)
- ✅ `backend/src/routes/index.ts` (Updated)
- ✅ `frontend/src/app/admin/hubtel-test/page.tsx` (Created)
- ✅ `frontend/src/components/admin/Sidebar.tsx` (Updated)

### Builds:
- ✅ Backend: Compiled successfully
- ✅ Frontend: Compiled successfully (34 routes)

### Remaining Tasks:
- ⏳ Deploy backend to production
- ⏳ Deploy frontend to hosting
- ⏳ Get production server IP from DigitalOcean
- ⏳ Contact Hubtel for IP whitelisting
- ⏳ Test on production after whitelisting

## 🆘 Support

**If you get stuck:**

1. **Check logs:**
   - DigitalOcean: App → Runtime Logs
   - Local: Terminal output

2. **Common errors:**
   - "Not authenticated": Login as Admin first
   - "500 error": Backend issue or Hubtel API issue
   - "Module not found": Run npm install

3. **Test locally first:**
   ```bash
   # Backend
   cd backend
   npm run dev

   # Frontend (new terminal)
   cd frontend
   npm run dev
   ```

   Access: http://localhost:3000/admin/hubtel-test

## 🎯 Next Steps

1. [ ] Deploy backend to DigitalOcean
2. [ ] Get production IP address
3. [ ] Email Hubtel for IP whitelisting (use template in HUBTEL_TEST_DEPLOYMENT.md)
4. [ ] Wait for Hubtel confirmation (usually 1-2 business days)
5. [ ] Deploy frontend
6. [ ] Test with small amount (GHS 1.00)
7. [ ] Test all payment methods:
   - [ ] Regular Receive Money
   - [ ] Preapproval (USSD & OTP)
   - [ ] Direct Debit Charge
   - [ ] Status Checks

## 📞 Hubtel Contact

**For IP whitelisting issues:**
- Support Email: support@hubtel.com
- Developer Portal: https://developers.hubtel.com
- Your Account: POS Sales ID `2036849`

---

**Ready to deploy? Start with Step 1: Get Production Server IP** 🚀

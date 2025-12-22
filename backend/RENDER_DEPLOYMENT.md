# Deploy to Render

This guide shows how to deploy your backend to Render.com with static IP for database whitelisting.

## Prerequisites

- GitHub account
- Render account (free to create at https://render.com)
- Your backend code pushed to GitHub

## Step 1: Sign Up and Connect GitHub

1. Go to https://render.com and sign up
2. Click "Get Started for Free"
3. Connect your GitHub account

## Step 2: Create New Web Service

1. Click "New +" button → "Web Service"
2. Connect your repository (authorize Render to access your GitHub)
3. Select your repository from the list

## Step 3: Configure Service

Fill in the following settings:

- **Name**: `hirepurchase-backend`
- **Region**: Choose closest to your users (e.g., Oregon, Frankfurt, Singapore)
- **Branch**: `main` or `master` (whichever you use)
- **Root Directory**: Leave empty (or `backend` if deploying from monorepo)
- **Runtime**: Node
- **Build Command**: `npm install && npm run build && npx prisma generate`
- **Start Command**: `node dist/index.js`
- **Plan**:
  - Free tier (no static IP, good for testing)
  - Starter ($7/month) - includes static IP for database whitelisting

## Step 4: Add Environment Variables

Click "Advanced" → "Add Environment Variable" and add these:

```
NODE_ENV=production
DATABASE_URL=your_postgresql_connection_string
JWT_SECRET=your_secret_key_here
HUBTEL_CLIENT_ID=your_hubtel_client_id
HUBTEL_CLIENT_SECRET=your_hubtel_client_secret
HUBTEL_MERCHANT_ID=your_hubtel_merchant_id
HUBTEL_WEBHOOK_URL=https://your-app.onrender.com/api/hubtel-webhook
FRONTEND_URL=https://your-frontend-url.com
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
SUPABASE_STORAGE_BUCKET=images
```

**Note**: Update `HUBTEL_WEBHOOK_URL` after deployment with your actual Render URL.

## Step 5: Deploy

1. Click "Create Web Service"
2. Render will automatically:
   - Clone your repository
   - Install dependencies
   - Build TypeScript
   - Generate Prisma Client
   - Start your app
3. Watch the deployment logs in real-time

## Step 6: Get Your Static IP (Starter Plan Only)

After deployment succeeds:

1. Go to your service dashboard
2. Click "Settings" in the left sidebar
3. Scroll to "Networking" section
4. Click "Enable" next to "Static Outbound IP Address"
5. Copy the IP address shown

**Use this IP to whitelist in**:
- Supabase dashboard (if using Supabase database)
- PostgreSQL hosting provider
- Any other service requiring IP whitelisting

## Step 7: Update Webhook URL

1. Copy your Render app URL (e.g., `https://hirepurchase-backend.onrender.com`)
2. Update the `HUBTEL_WEBHOOK_URL` environment variable:
   - Go to "Environment" tab
   - Edit `HUBTEL_WEBHOOK_URL` to `https://your-actual-url.onrender.com/api/hubtel-webhook`
3. Save and redeploy

## Step 8: Test Your API

Visit your deployed URL:
```
https://hirepurchase-backend.onrender.com
```

Test an endpoint:
```bash
curl https://hirepurchase-backend.onrender.com/api/health
```

## Auto-Deployment

Render automatically deploys when you push to your main branch:

1. Make changes to your code
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Update backend"
   git push origin main
   ```
3. Render automatically detects the push and redeploys

## Viewing Logs

- Go to your service dashboard
- Click "Logs" tab
- See real-time logs from your application

## Custom Domain (Optional)

1. Go to "Settings" → "Custom Domain"
2. Add your domain (e.g., `api.yourdomain.com`)
3. Update your DNS records as instructed
4. Render provides free SSL certificate

## Pricing

- **Free Tier**:
  - 750 hours/month
  - Spins down after 15 minutes of inactivity
  - No static IP
  - Good for testing

- **Starter Plan ($7/month)**:
  - Always on
  - Static outbound IP (for database whitelisting)
  - Recommended for production

## Troubleshooting

### Build Fails
- Check build logs in Render dashboard
- Verify build command is correct
- Ensure all dependencies are in package.json

### App Crashes on Start
- Check runtime logs
- Verify DATABASE_URL is correct
- Check all required environment variables are set

### Database Connection Issues
- Verify DATABASE_URL format is correct
- For Supabase: Use the connection pooling URL
- Whitelist your Render static IP in database settings

## Support

- Render Docs: https://render.com/docs
- Render Community: https://community.render.com

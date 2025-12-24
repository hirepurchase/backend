import { Router } from 'express';
import authRoutes from './auth';
import adminUserRoutes from './adminUsers';
import customerRoutes from './customers';
import productRoutes from './products';
import contractRoutes from './contracts';
import paymentRoutes from './payments';
import reportRoutes from './reports';
import roleRoutes from './roles';
import auditRoutes from './audit';
import notificationRoutes from './notifications';
import importRoutes from './import';
import paymentRetryRoutes from './paymentRetry';
import hubtelTestRoutes from './hubtelTest';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin-users', adminUserRoutes);
router.use('/customers', customerRoutes);
router.use('/customer', customerRoutes); // Alias for customer self-service
router.use('/products', productRoutes);
router.use('/contracts', contractRoutes);
router.use('/payments', paymentRoutes);
router.use('/payment-retry', paymentRetryRoutes);
router.use('/hubtel-test', hubtelTestRoutes);
router.use('/reports', reportRoutes);
router.use('/roles', roleRoutes);
router.use('/audit', auditRoutes);
router.use('/notifications', notificationRoutes);
router.use('/import', importRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get server IP (for Hubtel whitelisting)
router.get('/server-ip', async (req, res) => {
  try {
    const axios = require('axios');

    // Get IPv4
    let ipv4 = null;
    try {
      const ipv4Response = await axios.get('https://api.ipify.org?format=json');
      ipv4 = ipv4Response.data.ip;
    } catch (e) {
      console.error('Failed to get IPv4:', e);
    }

    // Get IPv6
    let ipv6 = null;
    try {
      const ipv6Response = await axios.get('https://api64.ipify.org?format=json');
      ipv6 = ipv6Response.data.ip;
    } catch (e) {
      console.error('Failed to get IPv6:', e);
    }

    res.json({
      ipv4: ipv4 || 'Not available',
      ipv6: ipv6 || 'Not available',
      note: 'Hubtel needs BOTH IPv4 and IPv6 addresses whitelisted. DigitalOcean uses IPv6 for outbound connections.',
      instruction: 'Send both IPs to Hubtel support for whitelisting'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get server IP' });
  }
});

// Test outbound IP by making request to webhook.site
router.get('/test-outbound-ip', async (req, res) => {
  try {
    const axios = require('axios');
    const webhookUrl = 'https://webhook.site/c92df202-4bb7-475a-8be3-bc208137339e';

    console.log('Making test request to webhook.site to verify outbound IP...');

    await axios.post(webhookUrl, {
      message: 'Test from DigitalOcean server',
      timestamp: new Date().toISOString(),
      purpose: 'Verify outbound IP address for Hubtel whitelisting'
    });

    res.json({
      success: true,
      message: 'Request sent to webhook.site',
      instruction: 'Check https://webhook.site/#!/c92df202-4bb7-475a-8be3-bc208137339e to see the source IP address',
      note: 'The IP shown in webhook.site is the exact IP that Hubtel will see'
    });
  } catch (error: any) {
    console.error('Test outbound IP error:', error);
    res.status(500).json({
      error: 'Failed to test outbound IP',
      details: error.message
    });
  }
});

export default router;

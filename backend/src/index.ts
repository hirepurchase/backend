// Load dotenv only in development (production uses environment variables set in hosting control panel)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import routes from './routes';
import prisma from './config/database';
import { initializeNotificationScheduler } from './services/notificationScheduler';
import { startPaymentRetryScheduler } from './services/paymentRetryScheduler';
import { initializeIdleShutdown, stopIdleShutdown, getTimeUntilShutdown, getLastActivityTime } from './services/idleShutdownService';
import { activityTracker } from './middleware/activityTracker';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" } // Allow images to be loaded from different origins
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Track activity for idle shutdown
app.use(activityTracker);

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check / root route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'AIDOO TECH Hire Purchase API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// API health check
app.get('/health', (req, res) => {
  const timeUntilShutdown = getTimeUntilShutdown();
  const minutesRemaining = Math.floor(timeUntilShutdown / 60000);
  const secondsRemaining = Math.floor((timeUntilShutdown % 60000) / 1000);

  res.json({
    status: 'healthy',
    database: 'connected',
    uptime: process.uptime(),
    idleShutdown: {
      enabled: true,
      timeoutMinutes: 15,
      timeRemaining: `${minutesRemaining}m ${secondsRemaining}s`,
      lastActivity: getLastActivityTime().toISOString(),
    },
  });
});

// API info route
app.get('/api', (req, res) => {
  res.json({
    name: 'AIDOO TECH Hire Purchase API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      auth: {
        adminLogin: 'POST /api/auth/admin/login',
        customerLogin: 'POST /api/auth/customer/login',
      },
      customers: 'GET /api/customers',
      contracts: 'GET /api/contracts',
      payments: 'GET /api/payments',
      products: 'GET /api/products',
      inventory: 'GET /api/inventory',
    },
    documentation: 'https://backend-3me8.onrender.com/',
  });
});

// Routes
app.use('/api', routes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing HTTP server...');
  stopIdleShutdown();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nSIGINT received. Closing HTTP server...');
  stopIdleShutdown();
  await prisma.$disconnect();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Initialize notification scheduler
  initializeNotificationScheduler();

  // Initialize payment retry scheduler
  startPaymentRetryScheduler();

  // Initialize idle shutdown service
  initializeIdleShutdown();
});

export default app;

/**
 * Idle Shutdown Service
 * Monitors server activity and shuts down after 15 minutes of inactivity
 */

const IDLE_TIMEOUT = 15 * 60 * 1000; // 15 minutes in milliseconds
const ENABLE_IDLE_SHUTDOWN = process.env.ENABLE_IDLE_SHUTDOWN
  ? process.env.ENABLE_IDLE_SHUTDOWN === 'true'
  : process.env.NODE_ENV !== 'production';
let idleTimer: NodeJS.Timeout | null = null;
let lastActivityTime: Date = new Date();

/**
 * Records activity and resets the idle timer
 */
export function recordActivity(): void {
  lastActivityTime = new Date();

  if (!ENABLE_IDLE_SHUTDOWN) {
    return;
  }

  // Clear existing timer
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  // Set new timer
  idleTimer = setTimeout(() => {
    console.log('⏰ Server idle for 15 minutes. Shutting down...');
    console.log(`Last activity: ${lastActivityTime.toISOString()}`);
    process.exit(0);
  }, IDLE_TIMEOUT);
}

/**
 * Gets the time remaining until shutdown
 */
export function getTimeUntilShutdown(): number {
  if (!ENABLE_IDLE_SHUTDOWN) {
    return Number.POSITIVE_INFINITY;
  }

  const now = new Date();
  const timeSinceLastActivity = now.getTime() - lastActivityTime.getTime();
  const timeRemaining = IDLE_TIMEOUT - timeSinceLastActivity;
  return Math.max(0, timeRemaining);
}

/**
 * Gets the last activity time
 */
export function getLastActivityTime(): Date {
  return lastActivityTime;
}

/**
 * Initialize the idle shutdown service
 */
export function initializeIdleShutdown(): void {
  if (!ENABLE_IDLE_SHUTDOWN) {
    console.log('🕒 Idle shutdown service disabled');
    lastActivityTime = new Date();
    return;
  }

  console.log('🕒 Idle shutdown service initialized (15-minute timeout)');
  recordActivity(); // Start the timer
}

/**
 * Stop the idle shutdown service
 */
export function stopIdleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
    console.log('🛑 Idle shutdown service stopped');
  }
}

export function isIdleShutdownEnabled(): boolean {
  return ENABLE_IDLE_SHUTDOWN;
}

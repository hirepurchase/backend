import prisma from '../../config/database';
import { liveActionsEnabled } from './config';

/**
 * Is this product a Transsion handset that PayTrigger manages?
 *
 * Used by the one guard line in Knox enrolment. It must never be the reason
 * a Samsung phone fails to enrol, so it answers false on any error — a missing
 * table, a dropped connection, anything — and Knox carries on as before.
 */

const TTL_MS = 60_000;
let products: Set<string> | null = null;
let loadedAt = 0;

async function load(): Promise<Set<string>> {
  if (products && Date.now() - loadedAt < TTL_MS) return products;
  const rows = await prisma.payTriggerProduct.findMany({ select: { productId: true } });
  products = new Set(rows.map((r) => r.productId));
  loadedAt = Date.now();
  return products;
}

export async function isPayTriggerProduct(productId: string | null | undefined): Promise<boolean> {
  try {
    if (!productId) return false;
    return (await load()).has(productId);
  } catch {
    return false;
  }
}

export function invalidatePayTriggerProducts(): void {
  products = null;
}

/**
 * Why a Transsion phone must not be sold yet, or null when it may be.
 *
 * A phone PayTrigger has never been given cannot be locked, and enrolling it
 * after the customer has set it up only takes effect at the next factory
 * reset. So the sale waits for the enrolment. Used by the contract guardrails;
 * it answers null for every Samsung phone and on any error, so it can never be
 * the reason a sale that should go through is stopped.
 */
export async function payTriggerSaleBlocker(inventoryItemId: string | null | undefined, productId: string | null | undefined): Promise<string | null> {
  try {
    if (!inventoryItemId || !(await isPayTriggerProduct(productId))) return null;
    const device = await prisma.payTriggerDevice.findUnique({
      where: { inventoryItemId },
      select: { id: true, enrollmentStatus: true, lastError: true },
    });
    const where = 'Enrol it from Inventory (PayTrigger → Enrol) before selling it.';
    if (!device) return `This phone has not been enrolled with PayTrigger, so it could not be locked if the customer stops paying. ${where}`;
    if (device.enrollmentStatus === 'FAILED') {
      return `PayTrigger did not accept this phone${device.lastError ? ` (${device.lastError})` : ''}, so it could not be locked. Fix the problem and enrol it again before selling it.`;
    }
    if (device.enrollmentStatus === 'CANCELLED') return `This phone's PayTrigger enrolment was cancelled, so it could not be locked. ${where}`;
    if (device.enrollmentStatus === 'REMOVED') {
      return 'This phone was released from PayTrigger and can no longer be locked. Ask Transsion to allow it to be enrolled again before selling it on hire purchase.';
    }
    // Live: an enrolment that was only simulated in dry run never reached PayTrigger.
    if (device.enrollmentStatus === 'QUEUED' && liveActionsEnabled()) {
      const proof = await prisma.payTriggerActionLog.findFirst({
        where: { deviceId: device.id, success: true, dryRun: false, action: { in: ['ENROL', 'VERIFY'] } },
        select: { id: true },
      });
      if (!proof) return `This phone was enrolled only in test mode, so PayTrigger does not hold it. ${where}`;
    }
    return null;
  } catch (err) {
    console.error('PayTrigger: sale check failed — sale allowed', err);
    return null;
  }
}

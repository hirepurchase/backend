import prisma from '../../config/database';

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

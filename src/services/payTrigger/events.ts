import { isTranssionContract } from './registry';

/**
 * The announcement line the existing code calls after its own Knox call:
 *
 *   notifyPayTrigger(contract.id, 'PAYMENT');   // no await
 *
 * Contract: returns immediately, never throws, never awaits, never touches the
 * database for a Samsung contract. The work happens after the caller has sent
 * its response. A lost event is caught by the 08:36 sweep.
 */

export type EventReason =
  | 'PAYMENT'
  | 'PAYMENT_REVERSED'
  | 'DEPOSIT_REMITTED'
  | 'TEMP_UNLOCK_APPROVED'
  | 'TEMP_UNLOCK_REVOKED'
  | 'CONTRACT_ACTIVE'
  | 'DEVICE_ENROLLED'
  | 'DEVICE_ACTIVATED'
  | 'DEVICE_REMOVED'
  | 'ADMIN_RECONCILE'
  | 'RETRY';

/** Reasons that mean the customer's side just moved — follow up with a status read. */
export const UNLOCK_REASONS: ReadonlySet<EventReason> = new Set<EventReason>(['PAYMENT', 'DEPOSIT_REMITTED', 'TEMP_UNLOCK_APPROVED']);

/**
 * A contract that has just gone active may not be linked to its PayTrigger
 * device yet, so it is not in the in-memory set. That reason alone is let
 * through to a link check — it fires once per contract, not per payment.
 */
const LINKING_REASONS: ReadonlySet<EventReason> = new Set<EventReason>(['CONTRACT_ACTIVE']);

interface Inbox {
  running: boolean;
  pending: Set<EventReason>;
}

const inboxes = new Map<string, Inbox>();

export function notifyPayTrigger(contractId: string | null | undefined, reason: EventReason): void {
  try {
    if (!contractId) return;
    if (!isTranssionContract(contractId) && !LINKING_REASONS.has(reason)) return;
    setImmediate(() => {
      enqueue(contractId, reason).catch((err) => console.error('PayTrigger: event failed', contractId, reason, err));
    });
  } catch {
    // never propagate into the caller
  }
}

/**
 * Per-contract inbox. Events that arrive while a reconcile for the same
 * contract is running are merged and run once more afterwards, so ten
 * payments in a second cost two reconciles, not ten.
 */
export async function enqueue(contractId: string, reason: EventReason): Promise<void> {
  let inbox = inboxes.get(contractId);
  if (!inbox) {
    inbox = { running: false, pending: new Set() };
    inboxes.set(contractId, inbox);
  }
  inbox.pending.add(reason);
  if (inbox.running) return;

  inbox.running = true;
  try {
    // Lazy import: reconcile imports this file, and the payment controllers
    // should not load the whole sidecar just to make the announcement call.
    const { reconcileContract } = await import('./reconcile');
    while (inbox.pending.size > 0) {
      const reasons = [...inbox.pending];
      inbox.pending.clear();
      try {
        await reconcileContract(contractId, { reasons });
      } catch (err) {
        console.error(`PayTrigger: reconcile failed for ${contractId}`, err);
      }
    }
  } finally {
    inbox.running = false;
    if (inbox.pending.size === 0) inboxes.delete(contractId);
  }
}

/** For the Phase 4 checks: how many reconciles ran since the last reset. */
export const eventStats = { reconciles: 0 };

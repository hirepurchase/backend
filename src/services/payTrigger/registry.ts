import prisma from '../../config/database';

/**
 * Contract IDs that have a PayTrigger device, held in memory.
 *
 * The existing payment code announces every contract it touches; this set is
 * how a Samsung contract is dropped without a database query. Loaded at
 * startup, updated when a device is linked or removed, and refreshed by the
 * morning sweep in case anything drifted.
 */

const contracts = new Set<string>();
let loaded = false;

export function isTranssionContract(contractId: string): boolean {
  return contracts.has(contractId);
}

export function addTranssionContract(contractId: string): void {
  contracts.add(contractId);
}

export function removeTranssionContract(contractId: string): void {
  contracts.delete(contractId);
}

export function registryLoaded(): boolean {
  return loaded;
}

export function registrySize(): number {
  return contracts.size;
}

export async function refreshTranssionContracts(): Promise<number> {
  const rows = await prisma.payTriggerDevice.findMany({
    where: { contractId: { not: null }, enrollmentStatus: { in: ['QUEUED', 'ACTIVE', 'UNENFORCEABLE'] } },
    select: { contractId: true },
  });
  contracts.clear();
  for (const row of rows) if (row.contractId) contracts.add(row.contractId);
  loaded = true;
  return contracts.size;
}

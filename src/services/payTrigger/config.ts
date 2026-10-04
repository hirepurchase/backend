/**
 * PayTrigger configuration.
 *
 * Safe by default, like Knox: unless both PAYTRIGGER_DRY_RUN=false and
 * PAYTRIGGER_ENABLE_LIVE_ACTIONS=true are set, every call is simulated and no
 * handset is touched. Reads that change nothing on the phone (status, licence,
 * model lookup) are allowed live whenever the key is configured, so the admin
 * screens can show real data while actions are still dry.
 */

const env = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();

export const PAYTRIGGER_BASE_URL = env('PAYTRIGGER_BASE_URL', 'https://paytrigger.transsion-os.com/PayTrigger').replace(/\/+$/, '');
export const PAYTRIGGER_API_KEY = env('PAYTRIGGER_API_KEY');
export const PAYTRIGGER_DRY_RUN = env('PAYTRIGGER_DRY_RUN', 'true').toLowerCase() !== 'false';
export const PAYTRIGGER_ENABLE_LIVE_ACTIONS = env('PAYTRIGGER_ENABLE_LIVE_ACTIONS', 'false').toLowerCase() === 'true';
export const PAYTRIGGER_TIMEOUT_MS = Number(env('PAYTRIGGER_TIMEOUT_MS', '15000')) || 15000;

/**
 * Contract numbers (or IDs) allowed live actions during the canary. Empty means
 * no restriction once live actions are on.
 */
export const PAYTRIGGER_CANARY_CONTRACTS = new Set(
  env('PAYTRIGGER_CANARY_CONTRACTS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Android package a pay link opens in. PayTrigger refuses a link sent without
 * its package (code 50012), and that refusal fails the whole request — an
 * enrolment or a lock-date update — so the two always travel together.
 */
export const PAYTRIGGER_APP_PACKAGE = env('PAYTRIGGER_APP_PACKAGE', 'com.aidootech.customer');

/** Currency symbol shown on the lock screen next to amounts. */
export const PAYTRIGGER_CURRENCY = env('PAYTRIGGER_CURRENCY', 'GHS');

export function isConfigured(): boolean {
  return Boolean(PAYTRIGGER_API_KEY);
}

/** True when actions that change a handset are really sent. */
export function liveActionsEnabled(): boolean {
  return isConfigured() && !PAYTRIGGER_DRY_RUN && PAYTRIGGER_ENABLE_LIVE_ACTIONS;
}

/** During the canary, only listed contracts get live actions. */
export function liveActionsAllowedFor(contract: { id: string; contractNumber?: string | null } | null): boolean {
  if (!liveActionsEnabled()) return false;
  if (PAYTRIGGER_CANARY_CONTRACTS.size === 0) return true;
  if (!contract) return false;
  return PAYTRIGGER_CANARY_CONTRACTS.has(contract.id)
    || (!!contract.contractNumber && PAYTRIGGER_CANARY_CONTRACTS.has(contract.contractNumber));
}

export function getConfigurationSummary() {
  return {
    configured: isConfigured(),
    baseUrl: PAYTRIGGER_BASE_URL,
    dryRun: !liveActionsEnabled(),
    liveActionsEnabled: liveActionsEnabled(),
    canaryContracts: PAYTRIGGER_CANARY_CONTRACTS.size,
  };
}

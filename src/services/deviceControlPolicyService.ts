import prisma from '../config/database';
import { isOverdue } from '../utils/helpers';
import {
  approveKnoxGuardDevice,
  blinkKnoxGuardDevice,
  cancelCompleteKnoxGuardDevice,
  completeKnoxGuardDevice,
  getKnoxGuardConfigurationSummary,
  lockKnoxGuardDevice,
  lookupKnoxGuardDevice,
  unlockKnoxGuardDevice,
} from './knoxGuardService';
import { getKnoxWebhookSecuritySummary } from '../utils/knoxWebhookSecurity';

type ManagedDeviceState = 'LOCKED' | 'UNLOCKED' | 'PENDING' | 'UNKNOWN';
type ManagedDeviceCommandType = 'APPROVE_DEVICE' | 'BLINK_DEVICE' | 'LOCK_DEVICE' | 'UNLOCK_DEVICE' | 'SYNC_DEVICE' | 'COMPLETE_DEVICE' | 'CANCEL_COMPLETE';
type ManagedDeviceEnrollmentState = 'PENDING' | 'APPROVAL_QUEUED' | 'APPROVED' | 'ACTIVE' | 'COMPLETING' | 'COMPLETE';

interface KnoxResponseSnapshot {
  actualState?: ManagedDeviceState;
  enrollmentStatus?: ManagedDeviceEnrollmentState;
  knoxStatus?: string | null;
  knoxObjectId?: string | null;
  knoxTenantDomain?: string | null;
}

interface KnoxGuardWebhookEnvelope {
  subscriptionId?: string | null;
  event: string;
  payload: Record<string, unknown>;
  traceId?: string | null;
  receivedAt?: string;
  validationMethod?: 'samsung-signature' | 'shared-token';
}

interface KnoxWebhookHistoryEntry {
  dedupeKey: string;
  traceId: string | null;
  event: string;
  deviceUid: string | null;
  deviceStatus: string | null;
  receivedAt: string;
  remoteUpdatedAt: string | null;
}

export interface KnoxGuardWebhookReconciliationResult {
  acknowledged: boolean;
  duplicate: boolean;
  ignored?: boolean;
  reason?: string;
  event: string;
  managedDeviceId?: string;
  contractId?: string;
  commandId?: string | null;
  actualState?: ManagedDeviceState;
  enrollmentStatus?: ManagedDeviceEnrollmentState;
  knoxStatus?: string | null;
}

interface EnrollmentInput {
  deviceUid?: string;
  deviceUidType?: string;
  approveId?: string;
  knoxObjectId?: string;
  knoxTenantDomain?: string;
  metadata?: Record<string, unknown>;
  actor?: {
    adminUserId?: string;
  };
}

export interface DeviceControlEnrollmentDefaults {
  disclosureVersion: string;
  disclosureSummary: string;
  termsReference: string | null;
  supportPhone: string | null;
  supportMessage: string;
  warningMessage: string;
  paymentAppPackage: string | null;
  paymentAppLabel: string;
  paymentUssd: string | null;
  refreshActionLabel: string;
  allowCustomerAppOnLockScreen: boolean;
  allowSupportOnLockScreen: boolean;
  allowPaymentUssdOnLockScreen: boolean;
}

interface DeviceControlCustomerExperience extends DeviceControlEnrollmentDefaults {
  disclosureAccepted: boolean;
  disclosureAcceptedAt: string | null;
  disclosureAcceptedByAdminId: string | null;
}

export interface CommandProcessSummary {
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{
    commandId: string;
    type: string;
    status: string;
    dryRun?: boolean;
    error?: string | null;
  }>;
}

// ─── DB-backed Knox Guard settings ────────────────────────────────────────────
// Settings are managed via the admin settings page and stored in KnoxGuardSettings.
// We cache the row for 60 seconds to avoid a DB round-trip on every policy evaluation.

interface KnoxSettings {
  lockAfterOverdueDays: number;
  blockOnUnpaidPenalties: boolean;
  maxCommandRetries: number;
  supportPhone: string | null;
  paymentAppPackage: string | null;
  paymentAppLabel: string;
  paymentUssd: string | null;
  refreshActionLabel: string;
  disclosureVersion: string;
  disclosureSummary: string;
  termsReference: string | null;
  supportMessage: string;
  warningMessage: string;
  allowCustomerAppOnLockScreen: boolean;
  allowSupportOnLockScreen: boolean;
  allowPaymentUssdOnLockScreen: boolean;
}

const KNOX_SETTINGS_DEFAULTS: KnoxSettings = {
  lockAfterOverdueDays: 7,
  blockOnUnpaidPenalties: false,
  maxCommandRetries: 3,
  supportPhone: null,
  paymentAppPackage: 'com.aidootech.customer',
  paymentAppLabel: 'AIDOO TECH',
  paymentUssd: null,
  refreshActionLabel: 'Refresh account status',
  disclosureVersion: 'v1',
  disclosureSummary: 'Customer informed that overdue payments can trigger device restriction while payment and support access remain available.',
  termsReference: null,
  supportMessage: 'Use the AIDOO TECH app, payment USSD, or customer support to bring the account back into good standing.',
  warningMessage: 'Your account is overdue. Please make payment now to avoid or remove device restriction.',
  allowCustomerAppOnLockScreen: true,
  allowSupportOnLockScreen: true,
  allowPaymentUssdOnLockScreen: true,
};

let _knoxSettingsCache: KnoxSettings | null = null;
let _knoxSettingsCacheAt = 0;
const KNOX_SETTINGS_CACHE_TTL_MS = 60_000;

async function getKnoxSettings(): Promise<KnoxSettings> {
  if (_knoxSettingsCache && Date.now() - _knoxSettingsCacheAt < KNOX_SETTINGS_CACHE_TTL_MS) {
    return _knoxSettingsCache;
  }
  try {
    const row = await (prisma as any).knoxGuardSettings.findFirst();
    _knoxSettingsCache = row ? (row as KnoxSettings) : KNOX_SETTINGS_DEFAULTS;
  } catch {
    _knoxSettingsCache = KNOX_SETTINGS_DEFAULTS;
  }
  _knoxSettingsCacheAt = Date.now();
  return _knoxSettingsCache!;
}
const BLOCK_INCOMING_CALLS_ON_LOCK = (process.env.KNOX_GUARD_BLOCK_INCOMING_CALLS || 'false').toLowerCase() === 'true';
const ALLOW_INCOMING_NUMBERS_RAW = (process.env.KNOX_GUARD_ALLOW_INCOMING_NUMBERS || '').trim();
const ALLOW_INCOMING_NUMBERS: string[] = ALLOW_INCOMING_NUMBERS_RAW
  ? ALLOW_INCOMING_NUMBERS_RAW.split(',').map((n) => n.trim()).filter(Boolean)
  : [];
// Blinking reminder config
const BLINK_BEFORE_LOCK_ENABLED = (process.env.KNOX_GUARD_BLINK_BEFORE_LOCK || 'true').toLowerCase() !== 'false';
const BLINK_AFTER_OVERDUE_DAYS = Number(process.env.KNOX_GUARD_BLINK_AFTER_OVERDUE_DAYS || '3');
const BLINK_INTERVAL_SECONDS = Number(process.env.KNOX_GUARD_BLINK_INTERVAL_SECONDS || '3600');
// Rate-limit retry delay (ms) when Knox returns 429
const RATE_LIMIT_RETRY_DELAY_MS = Number(process.env.KNOX_GUARD_RATE_LIMIT_RETRY_MS || '15000');
const KNOX_WEBHOOK_RECONCILIATION_ENABLED = getKnoxWebhookSecuritySummary().signatureCertificateConfigured;
const prismaAny = prisma as any;

function todayAtMidnight(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function computeDaysOverdue(dueDate: Date, gracePeriodDays: number): number {
  const dueWithGrace = new Date(dueDate);
  dueWithGrace.setDate(dueWithGrace.getDate() + gracePeriodDays);
  dueWithGrace.setHours(0, 0, 0, 0);

  const today = todayAtMidnight();
  const diffMs = today.getTime() - dueWithGrace.getTime();
  return diffMs > 0 ? Math.floor(diffMs / 86400000) : 0;
}

function buildApproveId(contractNumber: string): string {
  return contractNumber;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  return normalizeOptionalString(value, fallback) || fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }

  return fallback;
}

function normalizeStatusToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseKnoxTimestamp(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      const timestamp = Number(trimmed);
      if (Number.isFinite(timestamp)) {
        const numericDate = new Date(timestamp);
        if (!Number.isNaN(numericDate.getTime())) {
          return numericDate;
        }
      }
    }

    const parsedDate = new Date(trimmed);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  return null;
}

function normalizeKnoxWebhookEvent(value: string): string {
  return normalizeStatusToken(value);
}

function getCommandTypeForKnoxWebhookEvent(event: string): ManagedDeviceCommandType | null {
  switch (normalizeKnoxWebhookEvent(event)) {
    case 'KG_DEVICE_ENROLLED':
      return 'APPROVE_DEVICE';
    case 'KG_DEVICE_LOCKED':
      return 'LOCK_DEVICE';
    case 'KG_DEVICE_UNLOCKED':
      return 'UNLOCK_DEVICE';
    case 'KG_DEVICE_COMPLETED':
      return 'COMPLETE_DEVICE';
    default:
      return null;
  }
}

function resolveKnoxWebhookActualState(event: string, deviceStatus: string | null): ManagedDeviceState | undefined {
  switch (normalizeKnoxWebhookEvent(event)) {
    case 'KG_DEVICE_ENROLLED':
      return 'UNLOCKED';
    case 'KG_DEVICE_LOCKED':
      return 'LOCKED';
    case 'KG_DEVICE_UNLOCKED':
      return 'UNLOCKED';
    default:
      return deviceStatus ? resolveManagedState(deviceStatus) : undefined;
  }
}

function resolveKnoxWebhookEnrollmentStatus(
  event: string,
  currentEnrollmentStatus: string | null | undefined
): ManagedDeviceEnrollmentState | undefined {
  switch (normalizeKnoxWebhookEvent(event)) {
    case 'KG_DEVICE_ENROLLED':
      return 'APPROVED';
    case 'KG_DEVICE_LOCKED':
    case 'KG_DEVICE_UNLOCKED':
      return 'ACTIVE';
    case 'KG_DEVICE_COMPLETED':
      return 'COMPLETE';
    default:
      return currentEnrollmentStatus ? resolveEnrollmentState(currentEnrollmentStatus) : undefined;
  }
}

export async function getDeviceControlEnrollmentDefaults(): Promise<DeviceControlEnrollmentDefaults> {
  const s = await getKnoxSettings();
  return {
    disclosureVersion: s.disclosureVersion,
    disclosureSummary: s.disclosureSummary,
    termsReference: s.termsReference,
    supportPhone: s.supportPhone,
    supportMessage: s.supportMessage,
    warningMessage: s.warningMessage,
    paymentAppPackage: s.paymentAppPackage,
    paymentAppLabel: s.paymentAppLabel,
    paymentUssd: s.paymentUssd,
    refreshActionLabel: s.refreshActionLabel,
    allowCustomerAppOnLockScreen: s.allowCustomerAppOnLockScreen,
    allowSupportOnLockScreen: s.allowSupportOnLockScreen,
    allowPaymentUssdOnLockScreen: s.allowPaymentUssdOnLockScreen,
  };
}

function extractCustomerExperience(
  metadata: Record<string, unknown> | null | undefined,
  defaults: DeviceControlEnrollmentDefaults
): DeviceControlCustomerExperience {
  const source = isRecord(metadata?.customerExperience) ? metadata.customerExperience : {};

  const paymentUssd = normalizeOptionalString(source.paymentUssd, defaults.paymentUssd);
  const supportPhone = normalizeOptionalString(source.supportPhone, defaults.supportPhone);

  return {
    disclosureAccepted: normalizeBoolean(source.disclosureAccepted, false),
    disclosureAcceptedAt: normalizeOptionalString(source.disclosureAcceptedAt, null),
    disclosureAcceptedByAdminId: normalizeOptionalString(source.disclosureAcceptedByAdminId, null),
    disclosureVersion: normalizeRequiredString(source.disclosureVersion, defaults.disclosureVersion),
    disclosureSummary: normalizeRequiredString(source.disclosureSummary, defaults.disclosureSummary),
    termsReference: normalizeOptionalString(source.termsReference, defaults.termsReference),
    supportPhone,
    supportMessage: normalizeRequiredString(source.supportMessage, defaults.supportMessage),
    warningMessage: normalizeRequiredString(source.warningMessage, defaults.warningMessage),
    paymentAppPackage: normalizeOptionalString(source.paymentAppPackage, defaults.paymentAppPackage),
    paymentAppLabel: normalizeRequiredString(source.paymentAppLabel, defaults.paymentAppLabel),
    paymentUssd,
    refreshActionLabel: normalizeRequiredString(source.refreshActionLabel, defaults.refreshActionLabel),
    allowCustomerAppOnLockScreen: normalizeBoolean(source.allowCustomerAppOnLockScreen, defaults.allowCustomerAppOnLockScreen),
    allowSupportOnLockScreen: normalizeBoolean(source.allowSupportOnLockScreen, defaults.allowSupportOnLockScreen),
    allowPaymentUssdOnLockScreen: normalizeBoolean(
      source.allowPaymentUssdOnLockScreen,
      defaults.allowPaymentUssdOnLockScreen && Boolean(paymentUssd)
    ),
  };
}

function buildEnrollmentMetadata(
  existingMetadata: Record<string, unknown> | null,
  inputMetadata: Record<string, unknown> | undefined,
  defaults: DeviceControlEnrollmentDefaults,
  actor?: { adminUserId?: string }
) {
  const mergedMetadata = {
    ...(existingMetadata || {}),
    ...(inputMetadata || {}),
  };
  const source = isRecord(inputMetadata?.customerExperience) ? inputMetadata.customerExperience : {};
  const existingExperience = extractCustomerExperience(existingMetadata, defaults);

  const disclosureAccepted = normalizeBoolean(source.disclosureAccepted, existingExperience.disclosureAccepted);
  const paymentUssd = normalizeOptionalString(source.paymentUssd, existingExperience.paymentUssd);
  const supportPhone = normalizeOptionalString(source.supportPhone, existingExperience.supportPhone);

  const customerExperience: DeviceControlCustomerExperience = {
    disclosureAccepted,
    disclosureAcceptedAt: disclosureAccepted
      ? new Date().toISOString()
      : existingExperience.disclosureAcceptedAt,
    disclosureAcceptedByAdminId: disclosureAccepted
      ? actor?.adminUserId || existingExperience.disclosureAcceptedByAdminId
      : existingExperience.disclosureAcceptedByAdminId,
    disclosureVersion: normalizeRequiredString(source.disclosureVersion, existingExperience.disclosureVersion),
    disclosureSummary: normalizeRequiredString(source.disclosureSummary, existingExperience.disclosureSummary),
    termsReference: normalizeOptionalString(source.termsReference, existingExperience.termsReference),
    supportPhone,
    supportMessage: normalizeRequiredString(source.supportMessage, existingExperience.supportMessage),
    warningMessage: normalizeRequiredString(source.warningMessage, existingExperience.warningMessage),
    paymentAppPackage: normalizeOptionalString(source.paymentAppPackage, existingExperience.paymentAppPackage),
    paymentAppLabel: normalizeRequiredString(source.paymentAppLabel, existingExperience.paymentAppLabel),
    paymentUssd,
    refreshActionLabel: normalizeRequiredString(source.refreshActionLabel, existingExperience.refreshActionLabel),
    allowCustomerAppOnLockScreen: normalizeBoolean(source.allowCustomerAppOnLockScreen, existingExperience.allowCustomerAppOnLockScreen),
    allowSupportOnLockScreen: normalizeBoolean(source.allowSupportOnLockScreen, existingExperience.allowSupportOnLockScreen),
    allowPaymentUssdOnLockScreen: normalizeBoolean(
      source.allowPaymentUssdOnLockScreen,
      existingExperience.allowPaymentUssdOnLockScreen && Boolean(paymentUssd)
    ),
  };

  if (!customerExperience.disclosureAccepted) {
    throw new Error('Enrollment disclosure must be acknowledged before Knox Guard enrollment.');
  }

  if (!customerExperience.supportPhone) {
    throw new Error('A support phone number is required for the Knox Guard lock screen experience.');
  }

  if (!customerExperience.paymentAppPackage && !customerExperience.paymentUssd) {
    throw new Error('Provide a payment app package or payment USSD code before Knox Guard enrollment.');
  }

  return {
    ...mergedMetadata,
    customerExperience,
    enrolledFrom: 'contract',
    enrolledAt: new Date().toISOString(),
    enrolledByAdminId: actor?.adminUserId || normalizeOptionalString(mergedMetadata.enrolledByAdminId, null),
  };
}

function buildLockMessage(
  contract: any,
  overdueAmount: number,
  maxDaysOverdue: number,
  customerExperience: DeviceControlCustomerExperience
): string {
  const supportPhoneSuffix = customerExperience.supportPhone ? ` Support: ${customerExperience.supportPhone}.` : '';
  return [
    customerExperience.warningMessage,
    `Your AIDOO TECH phone is restricted because contract ${contract.contractNumber} is overdue.`,
    `Overdue amount: GHS ${overdueAmount.toFixed(2)}.`,
    `Maximum days overdue: ${maxDaysOverdue}.`,
    customerExperience.supportMessage,
    supportPhoneSuffix,
  ].join(' ').trim();
}

function parseJsonSafely(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readRecentWebhookHistory(metadata: Record<string, unknown> | null): KnoxWebhookHistoryEntry[] {
  const candidate = metadata?.recentWebhookEvents;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((entry): entry is KnoxWebhookHistoryEntry => {
    return isRecord(entry) && typeof entry.dedupeKey === 'string' && typeof entry.event === 'string';
  });
}

function buildWebhookDedupeKey(envelope: KnoxGuardWebhookEnvelope): string {
  const deviceUid = normalizeOptionalString(envelope.payload.deviceUid, null)
    || normalizeOptionalString(envelope.payload.imei, null)
    || normalizeOptionalString(envelope.payload.imei2, null)
    || 'unknown-device';
  const remoteUpdatedAt = normalizeOptionalString(envelope.payload.lastUpdatedAt, null) || 'unknown-update';
  const traceId = normalizeOptionalString(envelope.traceId, null);

  return traceId || `${normalizeKnoxWebhookEvent(envelope.event)}:${deviceUid}:${remoteUpdatedAt}`;
}

function appendWebhookHistory(
  metadata: Record<string, unknown> | null,
  envelope: KnoxGuardWebhookEnvelope
): { metadata: Record<string, unknown>; historyEntry: KnoxWebhookHistoryEntry; duplicate: boolean } {
  const existingMetadata = metadata || {};
  const recentWebhookEvents = readRecentWebhookHistory(existingMetadata);
  const dedupeKey = buildWebhookDedupeKey(envelope);
  const duplicate = recentWebhookEvents.some((entry) => entry.dedupeKey === dedupeKey);
  const historyEntry: KnoxWebhookHistoryEntry = {
    dedupeKey,
    traceId: normalizeOptionalString(envelope.traceId, null),
    event: normalizeKnoxWebhookEvent(envelope.event),
    deviceUid: normalizeOptionalString(envelope.payload.deviceUid, null)
      || normalizeOptionalString(envelope.payload.imei, null)
      || normalizeOptionalString(envelope.payload.imei2, null),
    deviceStatus: normalizeOptionalString(envelope.payload.deviceStatus, null),
    receivedAt: envelope.receivedAt || new Date().toISOString(),
    remoteUpdatedAt: normalizeOptionalString(envelope.payload.lastUpdatedAt, null),
  };

  const nextRecentWebhookEvents = duplicate
    ? recentWebhookEvents
    : [...recentWebhookEvents.slice(-19), historyEntry];

  return {
    duplicate,
    historyEntry,
    metadata: {
      ...existingMetadata,
      lastWebhookEvent: {
        ...historyEntry,
        subscriptionId: normalizeOptionalString(envelope.subscriptionId, null),
        validationMethod: envelope.validationMethod || null,
      },
      recentWebhookEvents: nextRecentWebhookEvents,
    },
  };
}

function mergeCommandWebhookResponse(
  existingResponse: string | null | undefined,
  webhookEnvelope: Record<string, unknown>
): string {
  const parsedExistingResponse = parseJsonSafely(existingResponse) || (existingResponse ? { raw: existingResponse } : {});
  const normalizedExistingResponse = isRecord(parsedExistingResponse)
    ? parsedExistingResponse
    : { raw: parsedExistingResponse };
  const webhookHistory = Array.isArray(normalizedExistingResponse.webhookHistory)
    ? normalizedExistingResponse.webhookHistory.filter((entry) => isRecord(entry)).slice(-4)
    : [];

  const mergedResponse = 'dispatchResponse' in normalizedExistingResponse
    ? normalizedExistingResponse
    : {
        dispatchResponse: normalizedExistingResponse,
      };

  return JSON.stringify({
    ...mergedResponse,
    webhook: webhookEnvelope,
    webhookHistory: [...webhookHistory, webhookEnvelope],
  });
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function collectResponseRecords(value: unknown, depth: number = 0): Record<string, unknown>[] {
  const normalized = parseJsonLike(value);

  if (depth > 4 || normalized === null || normalized === undefined) {
    return [];
  }

  if (Array.isArray(normalized)) {
    return normalized.flatMap((item) => collectResponseRecords(item, depth + 1));
  }

  if (!isRecord(normalized)) {
    return [];
  }

  return [
    normalized,
    ...Object.values(normalized).flatMap((item) => collectResponseRecords(item, depth + 1)),
  ];
}

function readResponseValue(records: Record<string, unknown>[], keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) {
        return record[key];
      }
    }
  }

  return undefined;
}

function resolveManagedState(value: unknown): ManagedDeviceState | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeStatusToken(value);
  if (!normalized) {
    return undefined;
  }

  if (
    ['LOCKED', 'DEVICE_LOCKED', 'RESTRICTED', 'RESTRICTION_APPLIED', 'BLOCKED'].includes(normalized) ||
    (normalized.includes('LOCK') && !normalized.includes('UNLOCK'))
  ) {
    return 'LOCKED';
  }

  if (
    ['UNLOCKED', 'DEVICE_UNLOCKED', 'ACTIVE', 'NORMAL', 'RELEASED', 'ENROLLED'].includes(normalized) ||
    normalized.includes('UNLOCK')
  ) {
    return 'UNLOCKED';
  }

  if (
    ['PENDING', 'PROCESSING', 'IN_PROGRESS', 'QUEUED', 'REQUESTED', 'WAITING', 'APPROVAL_QUEUED', 'ACCEPTED'].includes(normalized) ||
    normalized.includes('PENDING') ||
    normalized.includes('QUEUE') ||
    normalized.includes('PROCESS')
  ) {
    return 'PENDING';
  }

  if (['UNKNOWN', 'NOT_FOUND', 'UNAVAILABLE'].includes(normalized)) {
    return 'UNKNOWN';
  }

  return undefined;
}

function resolveEnrollmentState(value: unknown): ManagedDeviceEnrollmentState | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeStatusToken(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'COMPLETING' || normalized.includes('COMPLET') && normalized.includes('ING')) {
    return 'COMPLETING';
  }

  if (normalized.includes('COMPLETE')) {
    return 'COMPLETE';
  }

  if (normalized.includes('ACTIVE')) {
    return 'ACTIVE';
  }

  if (normalized.includes('APPROV')) {
    return 'APPROVED';
  }

  if (
    normalized.includes('QUEUE') ||
    normalized.includes('PENDING') ||
    normalized.includes('PROCESS') ||
    normalized.includes('REQUEST') ||
    normalized === 'ACCEPTED'
  ) {
    return 'APPROVAL_QUEUED';
  }

  return undefined;
}

function extractKnoxResponseSnapshot(data: unknown): KnoxResponseSnapshot {
  const records = collectResponseRecords(data);
  if (records.length === 0) {
    return {};
  }

  const stateValue = readResponseValue(records, [
    'actualState',
    'currentState',
    'deviceState',
    'lockStatus',
    'state',
    'deviceStatus',
    'status',
  ]);
  const enrollmentValue = readResponseValue(records, [
    'enrollmentStatus',
    'approvalStatus',
    'commandStatus',
    'resultStatus',
    'status',
    'state',
  ]);
  const knoxStatusValue = readResponseValue(records, [
    'knoxStatus',
    'deviceStatus',
    'status',
    'state',
    'commandStatus',
    'resultStatus',
  ]);

  return {
    actualState: resolveManagedState(stateValue),
    enrollmentStatus: resolveEnrollmentState(enrollmentValue),
    knoxStatus: normalizeOptionalString(knoxStatusValue, null),
    knoxObjectId: normalizeOptionalString(readResponseValue(records, ['knoxObjectId', 'objectId']), null),
    knoxTenantDomain: normalizeOptionalString(readResponseValue(records, ['knoxTenantDomain', 'tenantDomain', 'domain']), null),
  };
}

function resolveSuccessfulCommandState(
  commandType: ManagedDeviceCommandType,
  device: { actualState: ManagedDeviceState | string; desiredState: ManagedDeviceState | string },
  snapshot: KnoxResponseSnapshot
): ManagedDeviceState {
  if (snapshot.actualState) {
    return snapshot.actualState;
  }

  // BLINK and COMPLETE_DEVICE don't change the device lock state
  if (commandType === 'BLINK_DEVICE' || commandType === 'COMPLETE_DEVICE' || commandType === 'CANCEL_COMPLETE') {
    return (device.actualState as ManagedDeviceState) || 'UNKNOWN';
  }

  if (KNOX_WEBHOOK_RECONCILIATION_ENABLED && ['APPROVE_DEVICE', 'LOCK_DEVICE', 'UNLOCK_DEVICE'].includes(commandType)) {
    return 'PENDING';
  }

  if (commandType === 'LOCK_DEVICE') {
    return 'LOCKED';
  }

  if (commandType === 'UNLOCK_DEVICE') {
    return 'UNLOCKED';
  }

  if (device.actualState === 'UNKNOWN' && (device.desiredState === 'LOCKED' || device.desiredState === 'UNLOCKED')) {
    return device.desiredState;
  }

  return (device.actualState as ManagedDeviceState) || 'UNKNOWN';
}

function resolveSuccessfulEnrollmentStatus(
  commandType: ManagedDeviceCommandType,
  device: { enrollmentStatus: ManagedDeviceEnrollmentState | string; actualState: ManagedDeviceState | string },
  snapshot: KnoxResponseSnapshot,
  nextState: ManagedDeviceState
): ManagedDeviceEnrollmentState | undefined {
  if (snapshot.enrollmentStatus) {
    return snapshot.enrollmentStatus;
  }

  if (commandType === 'APPROVE_DEVICE') {
    return KNOX_WEBHOOK_RECONCILIATION_ENABLED ? 'APPROVAL_QUEUED' : 'APPROVED';
  }

  if (
    ['BLINK_DEVICE', 'LOCK_DEVICE', 'UNLOCK_DEVICE', 'SYNC_DEVICE'].includes(commandType) &&
    nextState !== 'UNKNOWN' &&
    nextState !== 'PENDING' &&
    ['APPROVED', 'APPROVAL_QUEUED', 'ACTIVE'].includes(String(device.enrollmentStatus).toUpperCase())
  ) {
    return 'ACTIVE';
  }

  return undefined;
}

function decorateManagedDeviceRecord<T extends { managedDevice?: any | null }>(record: T, defaults: DeviceControlEnrollmentDefaults): T & {
  managedDevice?: (T extends { managedDevice?: infer U } ? U : never) & {
    customerExperience: DeviceControlCustomerExperience;
  } | null;
} {
  if (!record.managedDevice) {
    return record as T & {
      managedDevice?: null;
    };
  }

  return {
    ...record,
    managedDevice: {
      ...record.managedDevice,
      customerExperience: extractCustomerExperience(parseJsonSafely(record.managedDevice.metadata), defaults),
    },
  } as T & {
    managedDevice?: (T extends { managedDevice?: infer U } ? U : never) & {
      customerExperience: DeviceControlCustomerExperience;
    } | null;
  };
}

function decorateStandaloneManagedDevice<T extends { metadata?: string | null }>(managedDevice: T, defaults: DeviceControlEnrollmentDefaults): T & {
  customerExperience: DeviceControlCustomerExperience;
} {
  return {
    ...managedDevice,
    customerExperience: extractCustomerExperience(parseJsonSafely(managedDevice.metadata), defaults),
  };
}

function buildLockCommandPayload(contract: any, metrics: { overdueAmount: number; maxDaysOverdue: number }, defaults: DeviceControlEnrollmentDefaults) {
  const customerExperience = extractCustomerExperience(parseJsonSafely(contract.managedDevice?.metadata), defaults);
  const customerPhone = contract.customer?.phone || null;

  return {
    message: buildLockMessage(contract, metrics.overdueAmount, metrics.maxDaysOverdue, customerExperience),
    tel: customerPhone || customerExperience.supportPhone || undefined,
    warningMessage: customerExperience.warningMessage,
    blockIncomingCalls: BLOCK_INCOMING_CALLS_ON_LOCK,
    allowIncomingNumbers: ALLOW_INCOMING_NUMBERS.length > 0 ? ALLOW_INCOMING_NUMBERS : undefined,
    lockScreen: {
      supportPhone: customerExperience.supportPhone,
      supportMessage: customerExperience.supportMessage,
      paymentAppPackage: customerExperience.paymentAppPackage,
      paymentAppLabel: customerExperience.paymentAppLabel,
      paymentUssd: customerExperience.paymentUssd,
      refreshActionLabel: customerExperience.refreshActionLabel,
      allowCustomerAppOnLockScreen: customerExperience.allowCustomerAppOnLockScreen,
      allowSupportOnLockScreen: customerExperience.allowSupportOnLockScreen,
      allowPaymentUssdOnLockScreen: customerExperience.allowPaymentUssdOnLockScreen,
    },
  };
}

function buildBlinkCommandPayload(contract: any, metrics: { overdueAmount: number; maxDaysOverdue: number }, defaults: DeviceControlEnrollmentDefaults) {
  const customerExperience = extractCustomerExperience(parseJsonSafely(contract.managedDevice?.metadata), defaults);
  const customerPhone = contract.customer?.phone || null;
  const message = [
    customerExperience.warningMessage,
    `Contract ${contract.contractNumber} overdue by GHS ${metrics.overdueAmount.toFixed(2)}.`,
    customerExperience.supportMessage,
  ].join(' ').slice(0, 200);

  return {
    message,
    tel: customerPhone || customerExperience.supportPhone || undefined,
    interval: BLINK_INTERVAL_SECONDS,
    timeLimitEnable: false,
  };
}

function makeIdempotencyKey(deviceId: string, type: ManagedDeviceCommandType): string {
  return `${deviceId}:${type}:${new Date().toISOString()}`;
}

async function getContractWithDevice(contractId: string) {
  return prismaAny.hirePurchaseContract.findUnique({
    where: { id: contractId },
    include: {
      customer: true,
      inventoryItem: true,
      installments: {
        orderBy: { installmentNo: 'asc' },
      },
      penalties: {
        where: { isPaid: false },
      },
      managedDevice: {
        include: {
          commands: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      },
    },
  });
}

async function queueManagedDeviceCommand(
  managedDeviceId: string,
  type: ManagedDeviceCommandType,
  payload: Record<string, unknown>
) {
  const existing = await prismaAny.managedDeviceCommand.findFirst({
    where: {
      managedDeviceId,
      type,
      status: { in: ['PENDING', 'PROCESSING'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    return existing;
  }

  return prismaAny.managedDeviceCommand.create({
    data: {
      managedDeviceId,
      type,
      idempotencyKey: makeIdempotencyKey(managedDeviceId, type),
      payload: JSON.stringify(payload),
      status: 'PENDING',
      nextAttemptAt: new Date(),
    },
  });
}

function getManagedDeviceIdentifier(device: {
  knoxObjectId?: string | null;
  deviceUid: string;
  approveId: string;
}) {
  return {
    objectId: device.knoxObjectId || undefined,
    deviceUid: device.deviceUid,
    approveId: device.approveId,
  };
}

async function findManagedDeviceForWebhook(payload: Record<string, unknown>) {
  const candidateDeviceIds = Array.from(new Set(
    [
      normalizeOptionalString(payload.deviceUid, null),
      normalizeOptionalString(payload.imei, null),
      normalizeOptionalString(payload.imei2, null),
    ].filter((value): value is string => Boolean(value))
  ));
  const knoxObjectId = normalizeOptionalString(payload.knoxObjectId, null)
    || normalizeOptionalString(payload.objectId, null);

  if (candidateDeviceIds.length === 0 && !knoxObjectId) {
    return null;
  }

  const orConditions: Array<Record<string, unknown>> = [];
  if (candidateDeviceIds.length > 0) {
    orConditions.push({ deviceUid: { in: candidateDeviceIds } });
  }
  if (knoxObjectId) {
    orConditions.push({ knoxObjectId });
  }

  return prismaAny.managedDevice.findFirst({
    where: {
      OR: orConditions,
    },
    include: {
      commands: {
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
    },
  });
}

function calculateOverdueMetrics(contract: any, blockOnUnpaidPenalties: boolean) {
  const overdueInstallments = contract.installments.filter((installment: any) => {
    if (installment.status === 'PAID') return false;
    return isOverdue(installment.dueDate, contract.gracePeriodDays);
  });

  const overdueAmount = overdueInstallments.reduce(
    (sum: number, installment: any) => sum + (installment.amount - installment.paidAmount),
    0
  );
  const unpaidPenaltyAmount = contract.penalties.reduce((sum: number, penalty: any) => sum + penalty.amount, 0);
  const maxDaysOverdue = overdueInstallments.reduce((max: number, installment: any) => {
    return Math.max(max, computeDaysOverdue(installment.dueDate, contract.gracePeriodDays));
  }, 0);

  return {
    overdueInstallments,
    overdueAmount: Number(overdueAmount.toFixed(2)),
    unpaidPenaltyAmount: Number(unpaidPenaltyAmount.toFixed(2)),
    blockingPenaltyAmount: Number((blockOnUnpaidPenalties ? unpaidPenaltyAmount : 0).toFixed(2)),
    maxDaysOverdue,
  };
}

export async function getDeviceControlPolicySummary() {
  const s = await getKnoxSettings();
  return {
    lockAfterOverdueDays: s.lockAfterOverdueDays,
    countUnpaidPenalties: s.blockOnUnpaidPenalties,
    penaltyBlockingEnabled: s.blockOnUnpaidPenalties,
    maxCommandRetries: s.maxCommandRetries,
    supportPhone: s.supportPhone,
    blockIncomingCallsOnLock: BLOCK_INCOMING_CALLS_ON_LOCK,
    allowIncomingNumbers: ALLOW_INCOMING_NUMBERS,
    customerExperienceDefaults: await getDeviceControlEnrollmentDefaults(),
    knoxGuard: getKnoxGuardConfigurationSummary(),
  };
}

export async function enrollManagedDeviceForContract(contractId: string, input: EnrollmentInput = {}) {
  const contract = await prismaAny.hirePurchaseContract.findUnique({
    where: { id: contractId },
    include: {
      customer: true,
      inventoryItem: true,
      managedDevice: true,
    },
  });

  if (!contract) {
    throw new Error('Contract not found');
  }

  if (!contract.customerId_uuid || !contract.customer) {
    throw new Error('Contract customer record is incomplete');
  }

  const deviceUid = input.deviceUid || contract.inventoryItem?.serialNumber;
  if (!deviceUid) {
    throw new Error('No device UID available. Provide a device UID or attach inventory with a serial number.');
  }

  const approveId = input.approveId || contract.managedDevice?.approveId || buildApproveId(contract.contractNumber);
  const enrollDefaults = await getDeviceControlEnrollmentDefaults();
  const metadata = buildEnrollmentMetadata(
    parseJsonSafely(contract.managedDevice?.metadata),
    input.metadata,
    enrollDefaults,
    input.actor
  );

  const managedDevice = await prismaAny.managedDevice.upsert({
    where: { contractId: contract.id },
    update: {
      inventoryItemId: contract.inventoryItem?.id || contract.managedDevice?.inventoryItemId || null,
      customerId_uuid: contract.customerId_uuid,
      deviceUid,
      deviceUidType: input.deviceUidType || contract.managedDevice?.deviceUidType || 'SERIAL_NUMBER',
      approveId,
      knoxObjectId: input.knoxObjectId ?? contract.managedDevice?.knoxObjectId ?? null,
      knoxTenantDomain: input.knoxTenantDomain ?? contract.managedDevice?.knoxTenantDomain ?? null,
      metadata: JSON.stringify(metadata),
      isActive: true,
      lastError: null,
    },
    create: {
      contractId: contract.id,
      inventoryItemId: contract.inventoryItem?.id || null,
      customerId_uuid: contract.customerId_uuid,
      deviceUid,
      deviceUidType: input.deviceUidType || 'SERIAL_NUMBER',
      approveId,
      knoxObjectId: input.knoxObjectId || null,
      knoxTenantDomain: input.knoxTenantDomain || null,
      metadata: JSON.stringify(metadata),
    },
  });

  const approveComment = [
    `Customer: ${contract.customer.firstName} ${contract.customer.lastName}`,
    `Contract: ${contract.contractNumber}`,
  ].join(' | ').slice(0, 1000);

  // Queue APPROVE_DEVICE immediately.
  // If Samsung still reports the device as 'Accepted', the command processor
  // will reschedule approval until the Knox Guard app connects on the phone.
  const command = await queueManagedDeviceCommand(managedDevice.id, 'APPROVE_DEVICE', {
    approveId: managedDevice.approveId,
    deviceUid: managedDevice.deviceUid,
    approveComment,
  });

  await prismaAny.managedDevice.update({
    where: { id: managedDevice.id },
    data: {
      // ACCEPTED = uploaded to Devices API, waiting for Knox Guard app on device to phone home
      enrollmentStatus: 'APPROVAL_QUEUED',
      desiredState: 'UNLOCKED',
      lastEvaluatedAt: new Date(),
    },
  });

  return {
    managedDeviceId: managedDevice.id,
    approveId: managedDevice.approveId,
    deviceUid: managedDevice.deviceUid,
    command,
  };
}

export async function getManagedDeviceHealthSummary() {
  const [devices, pendingCommands] = await Promise.all([
    prismaAny.managedDevice.count(),
    prismaAny.managedDeviceCommand.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    }),
  ]);

  return {
    devices,
    pendingCommands,
    policy: await getDeviceControlPolicySummary(),
  };
}

export async function listManagedDevices() {
  const devices = await prismaAny.managedDevice.findMany({
    include: {
      contract: {
        select: {
          id: true,
          contractNumber: true,
          status: true,
          outstandingBalance: true,
        },
      },
      customer: {
        select: {
          id: true,
          id_uuid: true,
          membershipId: true,
          firstName: true,
          lastName: true,
          phone: true,
        },
      },
      inventoryItem: {
        select: {
          id: true,
          serialNumber: true,
          lockStatus: true,
          status: true,
        },
      },
      commands: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const listDefaults = await getDeviceControlEnrollmentDefaults();
  return devices.map((device: any) => decorateStandaloneManagedDevice(device, listDefaults));
}

export async function listManagedDeviceCommands(limit: number = 50) {
  return prismaAny.managedDeviceCommand.findMany({
    include: {
      managedDevice: {
        select: {
          id: true,
          approveId: true,
          deviceUid: true,
          actualState: true,
          desiredState: true,
          contract: {
            select: {
              id: true,
              contractNumber: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getManagedDeviceByContract(contractId: string) {
  const contract = await getContractWithDevice(contractId);
  if (!contract) return null;
  const defs = await getDeviceControlEnrollmentDefaults();
  return decorateManagedDeviceRecord(contract, defs);
}

export async function reconcileKnoxGuardWebhookEvent(
  envelope: KnoxGuardWebhookEnvelope
): Promise<KnoxGuardWebhookReconciliationResult> {
  const normalizedEvent = normalizeKnoxWebhookEvent(envelope.event);

  if (!normalizedEvent) {
    throw new Error('Knox webhook event is required');
  }

  const managedDevice = await findManagedDeviceForWebhook(envelope.payload);
  const knownEvents = ['KG_DEVICE_ENROLLED', 'KG_DEVICE_LOCKED', 'KG_DEVICE_UNLOCKED', 'KG_DEVICE_COMPLETED'];
  if (!knownEvents.includes(normalizedEvent)) {
    const deviceUid = normalizeOptionalString(envelope.payload.deviceUid, null)
      || normalizeOptionalString(envelope.payload.imei, null)
      || 'unknown';
    console.warn(
      `Knox Guard: unrecognised webhook event "${normalizedEvent}" received for device ${deviceUid}. ` +
      `Payload keys: ${Object.keys(envelope.payload).join(', ')}`
    );
    return {
      acknowledged: true,
      duplicate: false,
      ignored: true,
      reason: `Unrecognised Knox webhook event: ${normalizedEvent}`,
      event: normalizedEvent,
    };
  }

  if (!managedDevice) {
    return {
      acknowledged: true,
      duplicate: false,
      ignored: true,
      reason: 'No managed device matched the Knox webhook payload',
      event: normalizedEvent,
    };
  }

  const existingMetadata = parseJsonSafely(managedDevice.metadata);
  const normalizedEnvelope: KnoxGuardWebhookEnvelope = {
    ...envelope,
    event: normalizedEvent,
    receivedAt: envelope.receivedAt || new Date().toISOString(),
  };
  const { metadata, historyEntry, duplicate } = appendWebhookHistory(existingMetadata, normalizedEnvelope);

  if (duplicate) {
    return {
      acknowledged: true,
      duplicate: true,
      event: normalizedEvent,
      managedDeviceId: managedDevice.id,
      contractId: managedDevice.contractId,
    };
  }

  const deviceStatus = normalizeOptionalString(envelope.payload.deviceStatus, managedDevice.knoxStatus || null);
  const actualState = resolveKnoxWebhookActualState(normalizedEvent, deviceStatus) || (managedDevice.actualState as ManagedDeviceState);
  const enrollmentStatus = resolveKnoxWebhookEnrollmentStatus(normalizedEvent, deviceStatus || managedDevice.enrollmentStatus)
    || (managedDevice.enrollmentStatus as ManagedDeviceEnrollmentState);
  const knoxStatus = deviceStatus || managedDevice.knoxStatus || null;
  const remoteUpdatedAt = parseKnoxTimestamp(envelope.payload.lastUpdatedAt) || new Date();
  const knoxObjectId = normalizeOptionalString(envelope.payload.knoxObjectId, null)
    || normalizeOptionalString(envelope.payload.objectId, null)
    || managedDevice.knoxObjectId
    || null;
  const knoxTenantDomain = normalizeOptionalString(envelope.payload.knoxTenantDomain, null)
    || normalizeOptionalString(envelope.payload.tenantDomain, null)
    || managedDevice.knoxTenantDomain
    || null;
  const commandType = getCommandTypeForKnoxWebhookEvent(normalizedEvent);
  const command = commandType
    ? managedDevice.commands.find((candidate: any) => candidate.type === commandType) || null
    : null;
  const webhookEnvelopeForStorage = {
    subscriptionId: normalizeOptionalString(envelope.subscriptionId, null),
    traceId: normalizeOptionalString(envelope.traceId, null),
    event: normalizedEvent,
    payload: envelope.payload,
    validationMethod: envelope.validationMethod || null,
    receivedAt: historyEntry.receivedAt,
  };

  const managedDeviceUpdate: Record<string, unknown> = {
    metadata: JSON.stringify(metadata),
    lastSyncedAt: new Date(),
    lastError: null,
    knoxStatus,
    knoxObjectId,
    knoxTenantDomain,
  };

  if (actualState) {
    managedDeviceUpdate.actualState = actualState;
  }

  if (enrollmentStatus) {
    managedDeviceUpdate.enrollmentStatus = enrollmentStatus;
  }

  if (normalizedEvent === 'KG_DEVICE_LOCKED') {
    managedDeviceUpdate.lastLockedAt = remoteUpdatedAt;
  }

  if (normalizedEvent === 'KG_DEVICE_UNLOCKED' || normalizedEvent === 'KG_DEVICE_ENROLLED') {
    managedDeviceUpdate.lastUnlockedAt = remoteUpdatedAt;
  }

  await prisma.$transaction(async (tx) => {
    const txAny = tx as any;

    await txAny.managedDevice.update({
      where: { id: managedDevice.id },
      data: managedDeviceUpdate,
    });

    if (managedDevice.inventoryItemId && ['KG_DEVICE_LOCKED', 'KG_DEVICE_UNLOCKED', 'KG_DEVICE_ENROLLED'].includes(normalizedEvent)) {
      await txAny.inventoryItem.update({
        where: { id: managedDevice.inventoryItemId },
        data: {
          lockStatus: actualState === 'LOCKED' ? 'LOCKED' : 'UNLOCKED',
        },
      });
    }

    if (command) {
      await txAny.managedDeviceCommand.update({
        where: { id: command.id },
        data: {
          status: 'SUCCEEDED',
          response: mergeCommandWebhookResponse(command.response, webhookEnvelopeForStorage),
          completedAt: remoteUpdatedAt,
          errorMessage: null,
          nextAttemptAt: null,
        },
      });
    }
  });

  await safelyEvaluateManagedDeviceForContract(managedDevice.contractId);

  return {
    acknowledged: true,
    duplicate: false,
    event: normalizedEvent,
    managedDeviceId: managedDevice.id,
    contractId: managedDevice.contractId,
    commandId: command?.id || null,
    actualState,
    enrollmentStatus,
    knoxStatus,
  };
}

export async function evaluateManagedDeviceForContract(contractId: string) {
  const contract = await getContractWithDevice(contractId);
  if (!contract) {
    throw new Error('Contract not found');
  }

  if (!contract.managedDevice) {
    throw new Error('Contract has no enrolled managed device');
  }

  const kSettings = await getKnoxSettings();
  const metrics = calculateOverdueMetrics(contract, kSettings.blockOnUnpaidPenalties);
  const isActive = contract.status === 'ACTIVE';
  const isOverdueEnoughToBlink = isActive && metrics.overdueAmount > 0 && metrics.maxDaysOverdue >= BLINK_AFTER_OVERDUE_DAYS;
  const isOverdueEnoughToLock = isActive && metrics.overdueAmount > 0 && metrics.maxDaysOverdue >= kSettings.lockAfterOverdueDays;
  const actualState = resolveManagedState(contract.managedDevice.actualState) || 'UNKNOWN';
  const enrollmentStatus = resolveEnrollmentState(contract.managedDevice.enrollmentStatus) || 'PENDING';
  const deviceCanAcceptControlCommand = ['APPROVED', 'APPROVAL_QUEUED', 'ACTIVE'].includes(enrollmentStatus);
  const deviceIsLockedOrPending = ['LOCKED', 'PENDING'].includes(actualState);
  const shouldLock = isOverdueEnoughToLock;
  const shouldBlink = BLINK_BEFORE_LOCK_ENABLED && isOverdueEnoughToBlink && !isOverdueEnoughToLock;
  const shouldUnlock = deviceIsLockedOrPending && metrics.overdueAmount === 0 && metrics.blockingPenaltyAmount === 0;
  const needsLockCommand = shouldLock
    && deviceCanAcceptControlCommand
    && !['LOCKED', 'PENDING'].includes(actualState);
  const needsUnlockCommand = shouldUnlock
    && deviceCanAcceptControlCommand
    && !['UNLOCKED', 'PENDING'].includes(actualState);

  const desiredState: ManagedDeviceState = shouldLock ? 'LOCKED' : 'UNLOCKED';
  let queuedCommand = null;

  if (needsLockCommand) {
    queuedCommand = await queueManagedDeviceCommand(
      contract.managedDevice.id,
      'LOCK_DEVICE',
      buildLockCommandPayload(contract, metrics, kSettings as DeviceControlEnrollmentDefaults)
    );
  } else if (shouldBlink && contract.managedDevice.desiredState !== 'LOCKED') {
    queuedCommand = await queueManagedDeviceCommand(
      contract.managedDevice.id,
      'BLINK_DEVICE',
      buildBlinkCommandPayload(contract, metrics, kSettings as DeviceControlEnrollmentDefaults)
    );
  } else if (needsUnlockCommand) {
    queuedCommand = await queueManagedDeviceCommand(contract.managedDevice.id, 'UNLOCK_DEVICE', {
      message: 'Your payment has been received. Your device has been unlocked.',
    });
  } else if (!shouldLock && contract.managedDevice.actualState === 'UNKNOWN' && !contract.managedDevice.lastSyncedAt) {
    queuedCommand = await queueManagedDeviceCommand(contract.managedDevice.id, 'SYNC_DEVICE', {
      reason: 'Initial sync requested by policy evaluation.',
    });
  }

  const updatedDevice = await prismaAny.managedDevice.update({
    where: { id: contract.managedDevice.id },
    data: {
      desiredState,
      lastEvaluatedAt: new Date(),
      lastError: null,
    },
  });

  return {
    contractId: contract.id,
    contractNumber: contract.contractNumber,
    metrics,
    desiredState,
    actualState: updatedDevice.actualState,
    queuedCommand,
  };
}

export async function safelyEvaluateManagedDeviceForContract(contractId: string): Promise<void> {
  try {
    await evaluateManagedDeviceForContract(contractId);
  } catch (error: any) {
    const message = error?.message || 'Unknown Knox Guard evaluation error';
    if (
      message === 'Contract has no enrolled managed device' ||
      message === 'Managed device not found for contract'
    ) {
      return;
    }

    console.error(`Knox Guard evaluation failed for contract ${contractId}:`, error);
  }
}

export async function requestManagedDeviceApprove(contractId: string) {
  const contract = await getContractWithDevice(contractId);
  if (!contract || !contract.managedDevice) {
    throw new Error('Managed device not found for contract');
  }

  const approveComment = [
    `Customer: ${contract.customer.firstName} ${contract.customer.lastName}`,
    `Contract: ${contract.contractNumber}`,
  ].join(' | ').slice(0, 1000);

  const command = await queueManagedDeviceCommand(contract.managedDevice.id, 'APPROVE_DEVICE', {
    approveId: contract.managedDevice.approveId,
    deviceUid: contract.managedDevice.deviceUid,
    approveComment,
  });

  await prismaAny.managedDevice.update({
    where: { id: contract.managedDevice.id },
    data: {
      enrollmentStatus: 'APPROVAL_QUEUED',
      lastEvaluatedAt: new Date(),
      lastError: null,
    },
  });

  return command;
}

export async function requestManagedDeviceLock(contractId: string, message?: string) {
  const contract = await getContractWithDevice(contractId);
  if (!contract || !contract.managedDevice) {
    throw new Error('Managed device not found for contract');
  }

  const lockDefaults = await getDeviceControlEnrollmentDefaults();
  const metrics = calculateOverdueMetrics(contract, (await getKnoxSettings()).blockOnUnpaidPenalties);
  const lockPayload = buildLockCommandPayload(contract, metrics, lockDefaults);
  const command = await queueManagedDeviceCommand(contract.managedDevice.id, 'LOCK_DEVICE', {
    ...lockPayload,
    message: message || lockPayload.message,
  });

  await prismaAny.managedDevice.update({
    where: { id: contract.managedDevice.id },
    data: {
      desiredState: 'LOCKED',
      lastEvaluatedAt: new Date(),
    },
  });

  return command;
}

export async function requestManagedDeviceUnlock(contractId: string, reason?: string) {
  const contract = await getContractWithDevice(contractId);
  if (!contract || !contract.managedDevice) {
    throw new Error('Managed device not found for contract');
  }

  const command = await queueManagedDeviceCommand(contract.managedDevice.id, 'UNLOCK_DEVICE', {
    message: reason || 'Manual unlock requested by administrator.',
    reason: reason || 'Manual unlock requested by administrator.',
  });

  await prismaAny.managedDevice.update({
    where: { id: contract.managedDevice.id },
    data: {
      desiredState: 'UNLOCKED',
      lastEvaluatedAt: new Date(),
    },
  });

  return command;
}

export async function unenrollManagedDeviceForContract(
  contractId: string,
  reason?: string
): Promise<{ success: boolean; dryRun: boolean; deviceId: string } | null> {
  const device = await prismaAny.managedDevice.findUnique({
    where: { contractId },
  });

  if (!device) {
    return null;
  }

  const result = await completeKnoxGuardDevice({
    objectId: device.knoxObjectId || undefined,
    deviceUid: device.deviceUid,
    approveId: device.approveId,
    message: reason || 'Contract completed — ownership transferred to customer.',
  });

  // Knox /devices/complete starts a 2-day window; mark COMPLETING until webhook confirms COMPLETE
  await prismaAny.managedDevice.update({
    where: { id: device.id },
    data: {
      enrollmentStatus: result.success ? 'COMPLETING' : device.enrollmentStatus,
      desiredState: 'UNLOCKED',
      lastSyncedAt: new Date(),
      lastError: result.success ? null : (result.error || 'Knox complete request failed'),
      lastKnoxAction: 'COMPLETE_DEVICE',
      lastTransactionId: result.transactionId || null,
    },
  });

  if (device.inventoryItemId && result.success) {
    await prismaAny.inventoryItem.update({
      where: { id: device.inventoryItemId },
      data: { lockStatus: 'UNLOCKED' },
    });
  }

  return { success: result.success, dryRun: result.dryRun, deviceId: device.id };
}

export async function cancelCompleteForContract(contractId: string): Promise<{ success: boolean; dryRun: boolean; deviceId: string } | null> {
  const device = await prismaAny.managedDevice.findUnique({
    where: { contractId },
  });

  if (!device) {
    return null;
  }

  if (device.enrollmentStatus !== 'COMPLETING') {
    throw new Error('Device is not in the COMPLETING state — cannot cancel completion.');
  }

  const result = await cancelCompleteKnoxGuardDevice({
    objectId: device.knoxObjectId || undefined,
    deviceUid: device.deviceUid,
    approveId: device.approveId,
  });

  await prismaAny.managedDevice.update({
    where: { id: device.id },
    data: {
      enrollmentStatus: result.success ? 'ACTIVE' : device.enrollmentStatus,
      lastSyncedAt: new Date(),
      lastError: result.success ? null : (result.error || 'Knox cancelComplete request failed'),
      lastKnoxAction: 'CANCEL_COMPLETE',
      lastTransactionId: result.transactionId || null,
    },
  });

  return { success: result.success, dryRun: result.dryRun, deviceId: device.id };
}

export async function resetStuckProcessingCommands(stuckAfterMinutes: number = 15): Promise<number> {
  const cutoff = new Date(Date.now() - stuckAfterMinutes * 60 * 1000);
  const result = await prismaAny.managedDeviceCommand.updateMany({
    where: {
      status: 'PROCESSING',
      lastAttemptAt: { lt: cutoff },
    },
    data: {
      status: 'FAILED',
      errorMessage: `Command stuck in PROCESSING for over ${stuckAfterMinutes} minutes — reset on scheduler startup.`,
      nextAttemptAt: new Date(),
    },
  });
  return result.count;
}

async function markCommandFailure(commandId: string, attempts: number, errorMessage: string | null) {
  const { maxCommandRetries } = await getKnoxSettings();
  const exhausted = attempts >= maxCommandRetries;
  const nextAttemptAt = exhausted
    ? null
    : new Date(Date.now() + Math.max(1, attempts) * 60 * 1000);

  const command = await prismaAny.managedDeviceCommand.update({
    where: { id: commandId },
    data: {
      status: 'FAILED',
      attempts,
      nextAttemptAt,
      errorMessage,
      lastAttemptAt: new Date(),
    },
    include: { managedDevice: { select: { id: true, approveId: true, contractId: true } } },
  });

  if (exhausted) {
    const exhaustedMessage = `Knox Guard command ${command.type} permanently failed after ${maxCommandRetries} retries. Last error: ${errorMessage || 'unknown'}`;
    console.error(`❌ Knox Guard: ${exhaustedMessage} (commandId=${commandId}, contract=${command.managedDevice?.contractId})`);

    await prismaAny.managedDevice.update({
      where: { id: command.managedDevice.id },
      data: {
        lastError: exhaustedMessage,
      },
    });
  }

  return command;
}

export async function processPendingManagedDeviceCommands(limit: number = 10): Promise<CommandProcessSummary> {
  const { maxCommandRetries } = await getKnoxSettings();
  const commands = await prismaAny.managedDeviceCommand.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      attempts: { lt: maxCommandRetries },
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: new Date() } },
      ],
    },
    include: {
      managedDevice: {
        include: {
          contract: {
            include: {
              customer: true,
              inventoryItem: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const summary: CommandProcessSummary = {
    processed: commands.length,
    succeeded: 0,
    failed: 0,
    results: [],
  };

  for (const command of commands) {
    const payload = parseJsonSafely(command.payload) || {};
    const identifier = getManagedDeviceIdentifier(command.managedDevice);

    await prismaAny.managedDeviceCommand.update({
      where: { id: command.id },
      data: {
        status: 'PROCESSING',
        lastAttemptAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    const attempts = command.attempts + 1;
    let result;

    try {
      switch (command.type as ManagedDeviceCommandType) {
        case 'APPROVE_DEVICE':
          result = await approveKnoxGuardDevice({
            ...identifier,
            approveComment: normalizeOptionalString(payload.approveComment, null) || undefined,
          });
          break;
        case 'BLINK_DEVICE':
          result = await blinkKnoxGuardDevice({
            ...identifier,
            message: String(payload.message || 'Your payment is overdue. Please pay to avoid device lock.'),
            tel: normalizeOptionalString(payload.tel, null) || undefined,
            interval: Number(payload.interval || BLINK_INTERVAL_SECONDS),
            timeLimitEnable: Boolean(payload.timeLimitEnable || false),
          });
          break;
        case 'LOCK_DEVICE':
          result = await lockKnoxGuardDevice({
            ...identifier,
            message: String(payload.message || 'Your device has been locked due to overdue payment.'),
            tel: normalizeOptionalString(payload.tel, null) || undefined,
            warningMessage: normalizeOptionalString(payload.warningMessage, null) || undefined,
            blockIncomingCalls: Boolean(payload.blockIncomingCalls ?? BLOCK_INCOMING_CALLS_ON_LOCK),
            allowIncomingNumbers: Array.isArray(payload.allowIncomingNumbers) ? payload.allowIncomingNumbers as string[] : undefined,
          });
          break;
        case 'UNLOCK_DEVICE':
          result = await unlockKnoxGuardDevice({
            ...identifier,
            message: normalizeOptionalString(payload.message, null)
              || normalizeOptionalString(payload.reason, null)
              || undefined,
          });
          break;
        case 'COMPLETE_DEVICE':
          result = await completeKnoxGuardDevice({
            ...identifier,
            message: normalizeOptionalString(payload.message, null) || undefined,
          });
          break;
        case 'CANCEL_COMPLETE':
          result = await cancelCompleteKnoxGuardDevice(identifier);
          break;
        case 'SYNC_DEVICE':
        default:
          result = await lookupKnoxGuardDevice(identifier);
          break;
      }
    } catch (error: any) {
      result = {
        success: false,
        dryRun: false,
        error: error.message || 'Knox Guard command dispatch failed',
      };
    }

    // 429 rate-limited — reschedule without burning a retry attempt
    if (!result.success && result.rateLimited) {
      await prismaAny.managedDeviceCommand.update({
        where: { id: command.id },
        data: {
          status: 'PENDING',
          attempts: command.attempts, // do NOT increment
          nextAttemptAt: new Date(Date.now() + RATE_LIMIT_RETRY_DELAY_MS),
          lastAttemptAt: new Date(),
          errorMessage: 'Rate limited by Knox Guard (429) — will retry shortly.',
        },
      });
      summary.results.push({ commandId: command.id, type: command.type, status: 'RATE_LIMITED', dryRun: false, error: result.error || null });
      continue;
    }

    // APPROVE_DEVICE: device is still in 'Accepted' state (Knox Guard app not yet installed on phone)
    // Reschedule every 2 minutes without burning a retry — it will auto-approve once the app connects
    if (
      !result.success &&
      command.type === 'APPROVE_DEVICE' &&
      (result.error?.includes('DEVICE_STATE_INVALID') || result.error?.includes("Current status is 'Accepted'"))
    ) {
      await prismaAny.managedDeviceCommand.update({
        where: { id: command.id },
        data: {
          status: 'PENDING',
          attempts: command.attempts, // do NOT burn retry
          nextAttemptAt: new Date(Date.now() + 2 * 60 * 1000), // retry in 2 min
          lastAttemptAt: new Date(),
          errorMessage: 'Device not yet registered by Knox Guard app — waiting for phone to connect.',
        },
      });
      await prismaAny.managedDevice.update({
        where: { id: command.managedDevice.id },
        data: {
          enrollmentStatus: 'APPROVAL_QUEUED',
          lastError: 'Waiting for Knox Guard app to connect on device.',
          lastKnoxAction: command.type,
        },
      });
      summary.results.push({ commandId: command.id, type: command.type, status: 'RATE_LIMITED', dryRun: false, error: 'Device in Accepted state — waiting for app' });
      continue;
    }

    if (!result.success) {
      summary.failed += 1;
      await markCommandFailure(command.id, attempts, result.error || 'Unknown Knox Guard error');
      await prismaAny.managedDevice.update({
        where: { id: command.managedDevice.id },
        data: {
          lastError: result.error || 'Unknown Knox Guard error',
          lastKnoxAction: command.type,
          lastTransactionId: result.transactionId || null,
          actualState: command.managedDevice.actualState,
        },
      });

      summary.results.push({
        commandId: command.id,
        type: command.type,
        status: 'FAILED',
        dryRun: result.dryRun,
        error: result.error || null,
      });
      continue;
    }

    summary.succeeded += 1;

    const isDryRun = result.dryRun;
    const snapshot = extractKnoxResponseSnapshot(result.data);
    const nextState = resolveSuccessfulCommandState(
      command.type as ManagedDeviceCommandType,
      {
        actualState: command.managedDevice.actualState,
        desiredState: command.managedDevice.desiredState,
      },
      snapshot
    );
    const nextEnrollmentStatus = resolveSuccessfulEnrollmentStatus(
      command.type as ManagedDeviceCommandType,
      {
        enrollmentStatus: command.managedDevice.enrollmentStatus,
        actualState: command.managedDevice.actualState,
      },
      snapshot,
      nextState
    );
    const nextKnoxStatus = snapshot.knoxStatus || nextState;

    const managedDeviceUpdate: Record<string, unknown> = {
      actualState: nextState,
      lastError: null,
      lastSyncedAt: new Date(),
      knoxStatus: nextKnoxStatus,
      lastKnoxAction: command.type,
      lastTransactionId: result.transactionId || null,
      metadata: JSON.stringify({
        ...(parseJsonSafely(command.managedDevice.metadata) || {}),
        lastCommandType: command.type,
        lastCommandResponse: result.data,
      }),
    };

    if (nextEnrollmentStatus) {
      managedDeviceUpdate.enrollmentStatus = nextEnrollmentStatus;
    }

    if (snapshot.knoxObjectId) {
      managedDeviceUpdate.knoxObjectId = snapshot.knoxObjectId;
    }

    if (snapshot.knoxTenantDomain) {
      managedDeviceUpdate.knoxTenantDomain = snapshot.knoxTenantDomain;
    }

    if (command.type === 'LOCK_DEVICE') {
      managedDeviceUpdate.lastLockedAt = new Date();
    }

    if (command.type === 'UNLOCK_DEVICE') {
      managedDeviceUpdate.lastUnlockedAt = new Date();
    }

    if (command.type === 'COMPLETE_DEVICE') {
      managedDeviceUpdate.enrollmentStatus = 'COMPLETING';
      managedDeviceUpdate.isActive = false;
    }

    await prisma.$transaction(async (tx) => {
      const txAny = tx as any;

      await txAny.managedDevice.update({
        where: { id: command.managedDevice.id },
        data: managedDeviceUpdate,
      });

      const nextInventoryLockStatus =
        nextState === 'LOCKED'
          ? 'LOCKED'
          : nextState === 'UNLOCKED'
            ? 'UNLOCKED'
            : null;

      if (command.managedDevice.inventoryItemId && nextInventoryLockStatus) {
        await txAny.inventoryItem.update({
          where: { id: command.managedDevice.inventoryItemId },
          data: {
            lockStatus: nextInventoryLockStatus,
          },
        });
      }

      await txAny.managedDeviceCommand.update({
        where: { id: command.id },
        data: {
          status: 'SUCCEEDED',
          response: JSON.stringify(result.data || null),
          completedAt: new Date(),
          errorMessage: null,
          nextAttemptAt: null,
        },
      });
    });

    summary.results.push({
      commandId: command.id,
      type: command.type,
      status: 'SUCCEEDED',
      dryRun: isDryRun,
      error: null,
    });

    if (command.type === 'APPROVE_DEVICE') {
      await safelyEvaluateManagedDeviceForContract(command.managedDevice.contractId);
    }
  }

  return summary;
}

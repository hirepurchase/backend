import axios from 'axios';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import jwt from 'jsonwebtoken';
import { getKnoxWebhookSecuritySummary } from '../utils/knoxWebhookSecurity';

export interface KnoxGuardConfigurationSummary {
  configured: boolean;
  dryRun: boolean;
  liveActionsEnabled: boolean;
  baseUrlConfigured: boolean;
  apiTokenConfigured: boolean;
  tokenRefreshConfigured: boolean;
  configuredPaths: Record<string, boolean>;
  webhookSignatureConfigured: boolean;
  webhookTokenConfigured: boolean;
  webhookValidationConfigured: boolean;
}

export interface KnoxGuardActionResult {
  success: boolean;
  dryRun: boolean;
  statusCode?: number;
  data?: unknown;
  error?: string;
  transactionId?: string;
  rateLimited?: boolean;
}

type DeviceIdentifier = {
  objectId?: string | null;
  deviceUid?: string | null;
  approveId?: string | null;
};

type AxiosInstance = ReturnType<typeof axios.create>;

const KNOX_GUARD_BASE_URL = (process.env.KNOX_GUARD_BASE_URL || '').trim();
const KNOX_GUARD_DRY_RUN = (process.env.KNOX_GUARD_DRY_RUN || 'true').toLowerCase() !== 'false';
const KNOX_GUARD_ENABLE_LIVE_ACTIONS = (process.env.KNOX_GUARD_ENABLE_LIVE_ACTIONS || 'false').toLowerCase() === 'true';
const KNOX_GUARD_TIMEOUT_MS = Number(process.env.KNOX_GUARD_TIMEOUT_MS || '15000');

// Token configuration — static token OR auto-refresh via Knox Cloud Authentication
const KNOX_GUARD_API_TOKEN_STATIC = (process.env.KNOX_GUARD_API_TOKEN || '').trim();
const KNOX_GUARD_CLIENT_IDENTIFIER = (process.env.KNOX_GUARD_CLIENT_IDENTIFIER || '').trim();
const KNOX_GUARD_PRIVATE_KEY_PATH = (process.env.KNOX_GUARD_PRIVATE_KEY_PATH || '').trim();
// Inline key takes priority over file path — useful for cloud deployments where
// mounting a file is not possible. Set KNOX_GUARD_PRIVATE_KEY to the full PEM content.
const KNOX_GUARD_PRIVATE_KEY_INLINE = (process.env.KNOX_GUARD_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n');
const KNOX_GUARD_ACCESS_TOKEN_VALIDITY_MINUTES = Number(process.env.KNOX_GUARD_ACCESS_TOKEN_VALIDITY_MINUTES || '30');
const KNOX_GUARD_JWT_AUDIENCE = 'KnoxWSM';
// Token expiry buffer: refresh 2 minutes before actual expiry
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
let warnedAboutPrivateKeyPathFallback = false;

const KNOX_GUARD_PATHS = {
  checkAuthorization: (process.env.KNOX_GUARD_CHECK_AUTH_PATH || '/authorization').trim(),
  listDevices: (process.env.KNOX_GUARD_LIST_DEVICES_PATH || '/devices/list').trim(),
  approveDevice: (process.env.KNOX_GUARD_APPROVE_DEVICE_PATH || '/devices/approve').trim(),
  lockDevice: (process.env.KNOX_GUARD_LOCK_DEVICE_PATH || '/devices/lock').trim(),
  unlockDevice: (process.env.KNOX_GUARD_UNLOCK_DEVICE_PATH || '/devices/unlock').trim(),
  blinkDevice: (process.env.KNOX_GUARD_BLINK_DEVICE_PATH || '/devices/blink').trim(),
  sendMessage: (process.env.KNOX_GUARD_SEND_MESSAGE_PATH || '/devices/sendMessage').trim(),
  completeDevice: (process.env.KNOX_GUARD_COMPLETE_DEVICE_PATH || '/devices/complete').trim(),
  cancelComplete: (process.env.KNOX_GUARD_CANCEL_COMPLETE_PATH || '/devices/cancelComplete').trim(),
};

// ─── Token refresh cache ───────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number; // Unix ms
}

let cachedToken: TokenCache | null = null;
const KNOX_HTTPS_AGENT = new https.Agent({ family: 4 });

function getKnoxTokenEndpoint(): string {
  if (KNOX_GUARD_BASE_URL) {
    return new URL('/ams/v1/users/accesstoken', KNOX_GUARD_BASE_URL).toString();
  }
  return 'https://us-kcs-api.samsungknox.com/ams/v1/users/accesstoken';
}

function formatPrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${compact.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

function looksLikeInlinePrivateKey(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith('-----BEGIN')) {
    return true;
  }

  const compact = trimmed.replace(/\s+/g, '');
  return compact.length > 256 && /^[A-Za-z0-9+/=]+$/.test(compact);
}

function loadPrivateKeyPem(): string {
  // 1. Inline env var (preferred for cloud — no file needed)
  if (KNOX_GUARD_PRIVATE_KEY_INLINE) {
    return formatPrivateKeyPem(KNOX_GUARD_PRIVATE_KEY_INLINE);
  }
  // 2. File path fallback
  if (!KNOX_GUARD_PRIVATE_KEY_PATH) {
    throw new Error('Knox Guard private key not configured. Set KNOX_GUARD_PRIVATE_KEY (inline) or KNOX_GUARD_PRIVATE_KEY_PATH (file path).');
  }

  // Some deployments accidentally store raw key material in the *_PATH variable.
  // Tolerate that misconfiguration so command processing doesn't fail hard.
  if (looksLikeInlinePrivateKey(KNOX_GUARD_PRIVATE_KEY_PATH)) {
    if (!warnedAboutPrivateKeyPathFallback) {
      warnedAboutPrivateKeyPathFallback = true;
      console.warn('Knox Guard: KNOX_GUARD_PRIVATE_KEY_PATH contains inline key material. Rename it to KNOX_GUARD_PRIVATE_KEY when possible.');
    }
    return formatPrivateKeyPem(KNOX_GUARD_PRIVATE_KEY_PATH);
  }

  const raw = fs.readFileSync(KNOX_GUARD_PRIVATE_KEY_PATH, 'utf8').trim();
  return formatPrivateKeyPem(raw);
}

function getBase64EncodedStringPublicKey(privateKeyPem = loadPrivateKeyPem()): string {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
}

function generateKnoxJwtId(): string {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

function signWithPrivateKey(payload: Record<string, unknown>, privateKeyPem = loadPrivateKeyPem()): string {
  return jwt.sign(
    { ...payload, publicKey: getBase64EncodedStringPublicKey(privateKeyPem) },
    privateKeyPem,
    {
      algorithm: 'RS512',
      audience: KNOX_GUARD_JWT_AUDIENCE,
      expiresIn: '30m',
      jwtid: generateKnoxJwtId(),
    }
  );
}

async function fetchFreshToken(): Promise<string> {
  if (!KNOX_GUARD_CLIENT_IDENTIFIER) {
    throw new Error('KNOX_GUARD_CLIENT_IDENTIFIER is not configured');
  }

  // Step 1 — sign the client identifier JWT with our private key
  const privateKeyPem = loadPrivateKeyPem();
  const clientIdentifierJwt = signWithPrivateKey({ clientIdentifier: KNOX_GUARD_CLIENT_IDENTIFIER }, privateKeyPem);
  const base64EncodedStringPublicKey = getBase64EncodedStringPublicKey(privateKeyPem);

  // Step 2 — exchange for an access token
  const response = await axios.post(
    getKnoxTokenEndpoint(),
    {
      clientIdentifierJwt,
      base64EncodedStringPublicKey,
      validityForAccessTokenInMinutes: KNOX_GUARD_ACCESS_TOKEN_VALIDITY_MINUTES,
    },
    {
      timeout: 10000,
      httpsAgent: KNOX_HTTPS_AGENT,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    } as any
  );

  const responseData = response.data as Record<string, unknown>;
  const rawAccessToken = responseData?.accessToken;
  if (!rawAccessToken || typeof rawAccessToken !== 'string') {
    throw new Error('Knox token endpoint did not return an accessToken');
  }

  // Step 3 — sign the access token with our private key before use as x-knox-apitoken
  const apiToken = signWithPrivateKey({ accessToken: rawAccessToken }, privateKeyPem);

  // Knox tokens expire every 30 minutes; cache for 28 min
  cachedToken = { token: apiToken, expiresAt: Date.now() + 28 * 60 * 1000 };
  return apiToken;
}

async function getApiToken(): Promise<string> {
  // Auto-refresh via Knox Cloud Authentication
  if (KNOX_GUARD_CLIENT_IDENTIFIER && (KNOX_GUARD_PRIVATE_KEY_INLINE || KNOX_GUARD_PRIVATE_KEY_PATH)) {
    if (!cachedToken || Date.now() >= cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return fetchFreshToken();
    }
    return cachedToken.token;
  }

  // Fall back to static token (useful during initial setup / testing)
  if (KNOX_GUARD_API_TOKEN_STATIC) {
    return KNOX_GUARD_API_TOKEN_STATIC;
  }

  throw new Error(
    'No Knox Guard API token configured. Set KNOX_GUARD_CLIENT_IDENTIFIER + KNOX_GUARD_PRIVATE_KEY_PATH, or KNOX_GUARD_API_TOKEN for a static token.'
  );
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

function generateTransactionId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `KG-${ts}-${rand}`;
}

async function buildClient(): Promise<AxiosInstance> {
  const token = await getApiToken();
  return axios.create({
    baseURL: KNOX_GUARD_BASE_URL,
    timeout: KNOX_GUARD_TIMEOUT_MS,
    httpsAgent: KNOX_HTTPS_AGENT,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-knox-apitoken': token,
    },
  } as any);
}

function isLiveModeReady(requiredPath: string): boolean {
  return Boolean(KNOX_GUARD_BASE_URL && KNOX_GUARD_ENABLE_LIVE_ACTIONS && requiredPath);
}

function summarizePaths(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(KNOX_GUARD_PATHS).map(([key, value]) => [key, Boolean(value)])
  );
}

function extractKnoxErrorMessage(error: any, fallback: string): string {
  const responseData = error?.response?.data;
  const nestedError = responseData?.error;

  return nestedError?.message
    || nestedError?.reason
    || responseData?.message
    || error?.message
    || fallback;
}

async function postAction(path: string, payload: Record<string, unknown>): Promise<KnoxGuardActionResult> {
  const transactionId = generateTransactionId();

  if (KNOX_GUARD_DRY_RUN || !isLiveModeReady(path)) {
    return {
      success: true,
      dryRun: true,
      transactionId,
      data: {
        message: 'Knox Guard action simulated locally.',
        payload,
        path,
        transactionId,
      },
    };
  }

  try {
    const client = await buildClient();
    const response = await client.post(path, payload, {
      headers: { 'x-knox-transactionId': transactionId },
    });
    return {
      success: true,
      dryRun: false,
      statusCode: response.status,
      transactionId,
      data: response.data,
    };
  } catch (error: any) {
    const statusCode = error.response?.status;

    // 429 — rate limited; caller must reschedule without burning a retry
    if (statusCode === 429) {
      return {
        success: false,
        dryRun: false,
        statusCode,
        transactionId,
        rateLimited: true,
        error: extractKnoxErrorMessage(error, 'Knox Guard rate limit exceeded (429). Request will be retried.'),
      };
    }

    return {
      success: false,
      dryRun: false,
      statusCode,
      transactionId,
      data: error.response?.data,
      error: extractKnoxErrorMessage(error, 'Knox Guard request failed'),
    };
  }
}

async function postListAction(path: string, body: Record<string, unknown>): Promise<KnoxGuardActionResult> {
  return postAction(path, body);
}

function normalizeIdentifier(identifier: DeviceIdentifier): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (identifier.objectId) payload.objectId = identifier.objectId;
  if (identifier.deviceUid) payload.deviceUid = identifier.deviceUid;
  if (identifier.approveId) payload.approveId = identifier.approveId;
  return payload;
}

// ─── Exported API functions ────────────────────────────────────────────────

export function getKnoxGuardConfigurationSummary(): KnoxGuardConfigurationSummary {
  const webhookSecurity = getKnoxWebhookSecuritySummary();
  const tokenRefreshConfigured = Boolean(KNOX_GUARD_CLIENT_IDENTIFIER && (KNOX_GUARD_PRIVATE_KEY_INLINE || KNOX_GUARD_PRIVATE_KEY_PATH));

  return {
    configured: Boolean(KNOX_GUARD_BASE_URL && (KNOX_GUARD_API_TOKEN_STATIC || tokenRefreshConfigured)),
    dryRun: KNOX_GUARD_DRY_RUN,
    liveActionsEnabled: KNOX_GUARD_ENABLE_LIVE_ACTIONS,
    baseUrlConfigured: Boolean(KNOX_GUARD_BASE_URL),
    apiTokenConfigured: Boolean(KNOX_GUARD_API_TOKEN_STATIC || tokenRefreshConfigured),
    tokenRefreshConfigured,
    configuredPaths: summarizePaths(),
    webhookSignatureConfigured: webhookSecurity.signatureCertificateConfigured,
    webhookTokenConfigured: webhookSecurity.sharedTokenConfigured,
    webhookValidationConfigured: webhookSecurity.validationConfigured,
  };
}

export async function checkKnoxGuardAuthorization(): Promise<KnoxGuardActionResult> {
  if (KNOX_GUARD_DRY_RUN || !isLiveModeReady(KNOX_GUARD_PATHS.checkAuthorization)) {
    return { success: true, dryRun: true, data: { message: 'Knox auth check simulated.' } };
  }
  const transactionId = generateTransactionId();
  try {
    const client = await buildClient();
    const response = await client.get(KNOX_GUARD_PATHS.checkAuthorization, {
      headers: { 'x-knox-transactionId': transactionId },
    });
    return { success: true, dryRun: false, statusCode: response.status, transactionId, data: response.data };
  } catch (error: any) {
    return {
      success: false, dryRun: false, statusCode: error.response?.status, transactionId,
      error: extractKnoxErrorMessage(error, 'Knox authorization check failed'),
    };
  }
}

export async function lookupKnoxGuardDevice(identifier: DeviceIdentifier): Promise<KnoxGuardActionResult> {
  const id = normalizeIdentifier(identifier);
  const search = id.objectId || id.deviceUid || id.approveId;
  return postListAction(KNOX_GUARD_PATHS.listDevices, {
    search: search ? String(search) : undefined,
    pageNum: 0,
    pageSize: 1,
  });
}

export async function approveKnoxGuardDevice(payload: DeviceIdentifier & {
  approveComment?: string;
}): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.approveDevice, {
    ...normalizeIdentifier(payload),
    ...(payload.approveComment ? { approveComment: payload.approveComment } : {}),
  });
}

export async function lockKnoxGuardDevice(payload: DeviceIdentifier & {
  message: string;
  tel?: string | null;
  email?: string | null;
  blockIncomingCalls?: boolean;
  allowIncomingNumbers?: string[];
  warningMessage?: string;
}): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.lockDevice, {
    ...normalizeIdentifier(payload),
    message: payload.message,
    ...(payload.tel ? { tel: payload.tel } : {}),
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.blockIncomingCalls !== undefined ? { blockIncomingCalls: payload.blockIncomingCalls } : {}),
    ...(payload.allowIncomingNumbers?.length ? { allowIncomingNumbers: payload.allowIncomingNumbers } : {}),
    ...(payload.warningMessage ? { warningMessage: payload.warningMessage } : {}),
  });
}

export async function unlockKnoxGuardDevice(payload: DeviceIdentifier & {
  message?: string;
}): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.unlockDevice, {
    ...normalizeIdentifier(payload),
    ...(payload.message ? { message: payload.message } : {}),
  });
}

export async function blinkKnoxGuardDevice(payload: DeviceIdentifier & {
  message: string;
  tel?: string | null;
  email?: string | null;
  interval?: number;
  timeLimitEnable?: boolean;
  timeLimit?: [number, number];
}): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.blinkDevice, {
    ...normalizeIdentifier(payload),
    message: payload.message,
    interval: payload.interval ?? 3600,
    ...(payload.tel ? { tel: payload.tel } : {}),
    ...(payload.email ? { email: payload.email } : {}),
    ...(payload.timeLimitEnable !== undefined ? { timeLimitEnable: payload.timeLimitEnable } : {}),
    ...(payload.timeLimit ? { timeLimit: payload.timeLimit } : {}),
  });
}

export async function completeKnoxGuardDevice(payload: DeviceIdentifier & {
  message?: string;
}): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.completeDevice, {
    ...normalizeIdentifier(payload),
    ...(payload.message ? { message: payload.message } : {}),
  });
}

export async function cancelCompleteKnoxGuardDevice(payload: DeviceIdentifier): Promise<KnoxGuardActionResult> {
  return postAction(KNOX_GUARD_PATHS.cancelComplete, {
    ...normalizeIdentifier(payload),
  });
}

export interface KnoxUploadOptions {
  autoAccept?: boolean;
  autoLock?: boolean;
  applySimControl?: boolean;
  enableBlockFactoryReset?: boolean;
  blockDOProvision?: boolean;
  blockADBCommand?: boolean;
}

// ─── Devices API (separate from Knox Guard — manages device registration) ─────

const DEVICES_API_BASE_URL = (process.env.DEVICES_API_BASE_URL || '').trim();
const DEVICES_API_KEY = (process.env.DEVICES_API_KEY || '').trim();

function buildDevicesApiClient() {
  return axios.create({
    baseURL: DEVICES_API_BASE_URL,
    timeout: KNOX_GUARD_TIMEOUT_MS,
    headers: {
      'x-vtkdp-key': DEVICES_API_KEY,
      'Content-Type': 'application/json',
    },
    httpsAgent: KNOX_HTTPS_AGENT,
  } as any);
}

function isDevicesApiReady(): boolean {
  return !!(DEVICES_API_BASE_URL && DEVICES_API_KEY);
}

export interface DevicesApiResult {
  success: boolean;
  dryRun: boolean;
  statusCode?: number;
  data?: unknown;
  error?: string;
  transactionId?: string;
}

// POST /devices/upload — register IMEIs; returns transaction_id for polling
export async function uploadKnoxGuardDevices(
  imeis: string[],
  _options: KnoxUploadOptions = {}
): Promise<KnoxGuardActionResult> {
  if (KNOX_GUARD_DRY_RUN || !isDevicesApiReady()) {
    return {
      success: true,
      dryRun: true,
      data: { transaction_id: `dry-run-${Date.now()}`, status: 'Progress', message: 'Simulated upload.' },
    };
  }
  try {
    const client = buildDevicesApiClient();
    const response = await client.post('/devices/upload', { devices: imeis });
    const body = response.data as any;
    if (body?.errors?.length) {
      return { success: false, dryRun: false, statusCode: response.status, data: body, error: body.message };
    }
    return { success: true, dryRun: false, statusCode: response.status, data: body.data };
  } catch (error: any) {
    const body = error.response?.data as any;
    return {
      success: false,
      dryRun: false,
      statusCode: error.response?.status,
      data: body,
      error: body?.errors?.[0]?.message || body?.message || error.message || 'Devices API upload failed',
    };
  }
}

// GET /devices/transaction-status/{transactionId} — poll upload or delete result
export async function getKnoxGuardUploadStatus(transactionId: string): Promise<KnoxGuardActionResult> {
  if (KNOX_GUARD_DRY_RUN || !isDevicesApiReady()) {
    return {
      success: true,
      dryRun: true,
      data: { status: 'Complete', devices: null },
    };
  }
  try {
    const client = buildDevicesApiClient();
    const response = await client.get(`/devices/transaction-status/${transactionId}`);
    const body = response.data as any;
    // HTTP 201 = completed with partial failures; 200 = all succeeded
    const hasFailures = response.status === 201 && Array.isArray(body?.data?.devices);
    return {
      success: !hasFailures,
      dryRun: false,
      statusCode: response.status,
      data: body.data,
    };
  } catch (error: any) {
    const body = error.response?.data as any;
    return {
      success: false,
      dryRun: false,
      statusCode: error.response?.status,
      data: body,
      error: body?.errors?.[0]?.message || body?.message || error.message || 'Transaction status check failed',
    };
  }
}

// GET /devices — list all devices registered to the tenant
export async function listDevicesFromApi(): Promise<DevicesApiResult> {
  if (KNOX_GUARD_DRY_RUN || !isDevicesApiReady()) {
    return { success: true, dryRun: true, data: { result: 'SUCCESS', totalCount: 0, deviceList: [] } };
  }
  try {
    const client = buildDevicesApiClient();
    const response = await client.get('/devices');
    const body = response.data as any;
    if (body?.errors?.length) {
      return { success: false, dryRun: false, statusCode: response.status, data: body, error: body.message };
    }
    return { success: true, dryRun: false, statusCode: response.status, data: body.data };
  } catch (error: any) {
    const body = error.response?.data as any;
    return {
      success: false,
      dryRun: false,
      statusCode: error.response?.status,
      data: body,
      error: body?.errors?.[0]?.message || body?.message || error.message || 'Devices API list failed',
    };
  }
}

// DELETE /devices/delete — remove IMEIs from tenant; returns transactionId for polling
export async function deleteDevicesFromApi(imeis: string[]): Promise<DevicesApiResult> {
  if (KNOX_GUARD_DRY_RUN || !isDevicesApiReady()) {
    return {
      success: true,
      dryRun: true,
      data: { result: 'SUCCESS', transactionId: `dry-run-del-${Date.now()}`, message: 'Simulated delete.' },
    };
  }
  try {
    const client = buildDevicesApiClient();
    const response = await client.delete('/devices/delete', { data: { devices: imeis } } as any);
    const body = response.data as any;
    if (body?.errors?.length) {
      return { success: false, dryRun: false, statusCode: response.status, data: body, error: body.message };
    }
    return { success: true, dryRun: false, statusCode: response.status, data: body.data };
  } catch (error: any) {
    const body = error.response?.data as any;
    return {
      success: false,
      dryRun: false,
      statusCode: error.response?.status,
      data: body,
      error: body?.errors?.[0]?.message || body?.message || error.message || 'Devices API delete failed',
    };
  }
}

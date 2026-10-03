import axios from 'axios';
import {
  PAYTRIGGER_API_KEY,
  PAYTRIGGER_BASE_URL,
  PAYTRIGGER_TIMEOUT_MS,
  isConfigured,
  liveActionsEnabled,
} from './config';
import { flatten, sign } from './sign';
import { describeCode, isPermanent, isRateLimited } from './errors';

/**
 * Thin client for the PayTrigger Partner API.
 *
 * Every request goes through `postAction`, which decides dry-run vs live,
 * signs, applies the timeout and turns PayTrigger's {code, message, data}
 * envelope into a PayTriggerResult. Nothing here touches the database; the
 * caller records what happened.
 */

export interface PayTriggerResult<T = unknown> {
  success: boolean;
  dryRun: boolean;
  code?: string;
  message?: string;
  data?: T;
  error?: string;
  rateLimited?: boolean;
  permanent?: boolean;
  request?: Record<string, unknown>;
}

/** Changes a handset or spends a licence → simulated unless live actions are on. */
type Kind = 'action' | 'read';

const PATHS = {
  enrol: '/api/partner/lock/v1/imei/input',
  cancelEnrolment: '/api/partner/lock/v1/imei/cancel',
  updateRepayInfo: '/api/partner/lock/v1/updateRepayInfo',
  removeLock: '/api/partner/lock/v1/removeLock',
  findLockState: '/api/partner/lock/v1/findLockState',
  batchFindLockState: '/api/partner/lock/v1/batchFindLockState',
  getDevice: '/api/partner/lock/v1/getDevice',
  getModel: '/api/partner/model/v1/get',
  setLockRule: '/api/partner/lockRule/v1/setLockRule',
  updateLadder: '/api/partner/company/v1/lock-rule/update',
  updateBranding: '/api/partner/company/v1/customize/update',
  companyConfig: '/api/partner/company/v1/queryCompanyConfigInfo',
  checkLicence: '/api/partner/company/v1/checkLicense',
  issuePin: '/api/partner/unlock/v1/verifyCode',
} as const;

/** The key field is named `relatedMerchant` on updateRepayInfo, `apiKey` everywhere else. */
async function postAction<T>(
  kind: Kind,
  path: string,
  fields: Record<string, unknown>,
  options: { keyField?: 'apiKey' | 'relatedMerchant'; simulate?: () => T } = {},
): Promise<PayTriggerResult<T>> {
  const keyField = options.keyField ?? 'apiKey';
  const body = flatten({ ...fields, [keyField]: PAYTRIGGER_API_KEY || 'DRY_RUN' });
  // Never log or store the key itself.
  const request = { path, ...body, [keyField]: '***' };

  const live = kind === 'read' ? isConfigured() : liveActionsEnabled();
  if (!live) {
    return {
      success: true,
      dryRun: true,
      code: '200',
      message: 'Simulated (dry run)',
      data: options.simulate ? options.simulate() : undefined,
      request,
    };
  }

  try {
    const response = await axios.post(`${PAYTRIGGER_BASE_URL}${path}`, body, {
      timeout: PAYTRIGGER_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        sign: sign(body, PAYTRIGGER_API_KEY),
      },
      // PayTrigger reports failures in the body; let us read every status.
      validateStatus: () => true,
    });

    const payload = (response.data ?? {}) as { code?: number | string; message?: string; data?: T };
    const code = payload.code !== undefined ? String(payload.code) : String(response.status);
    const success = code === '200';
    return {
      success,
      dryRun: false,
      code,
      message: payload.message,
      data: payload.data,
      error: success ? undefined : describeCode(code, payload.message),
      rateLimited: isRateLimited(code),
      permanent: isPermanent(code),
      request,
    };
  } catch (err: any) {
    // Network failure or timeout: the request may or may not have landed.
    return {
      success: false,
      dryRun: false,
      error: err?.code === 'ECONNABORTED' ? 'PayTrigger did not answer in time.' : `PayTrigger unreachable: ${err?.message || err}`,
      request,
    };
  }
}

const toSeconds = (d: Date) => Math.floor(d.getTime() / 1000);
const money = (n: number | null | undefined) => (n === null || n === undefined ? undefined : Math.round(n * 100) / 100);

// ─── Enrolment ─────────────────────────────────────────────────────────────

export interface EnrolItem {
  imei: string;
  orderNum?: string;
  model?: string;
  ruleNum?: number;
  deeplink?: string;
  deeplinkPkg?: string;
}

export interface EnrolFailure {
  imei: string;
  message: string;
  errCode: string | number;
}

/**
 * Pre-enrol IMEIs. With preLockFlag=true the phone locks itself the moment it
 * activates, which is what keeps it shut until the agent's deposit is in.
 * No licence is used until activation.
 */
export function enrolImeis(items: EnrolItem[], preLockFlag = true) {
  const imeiInfo = items.map((item) => {
    // Keys in ASCII order, as the doc asks for nested arrays.
    const entry: Record<string, unknown> = {};
    const raw: Record<string, unknown> = {
      deeplink: item.deeplink,
      deeplinkPkg: item.deeplinkPkg,
      imei: item.imei,
      model: item.model,
      nextRepaymentTimeSwitch: true,
      orderNum: item.orderNum,
      ruleNum: item.ruleNum,
    };
    for (const key of Object.keys(raw).sort()) {
      if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') entry[key] = raw[key];
    }
    return entry;
  });
  return postAction<EnrolFailure[]>('action', PATHS.enrol, { imeiInfo, preLockFlag }, { simulate: () => [] });
}

/** Before activation only — gives the licence slot back. */
export function cancelEnrolment(imeis: string[]) {
  return postAction<EnrolFailure[]>('action', PATHS.cancelEnrolment, { imeiInfo: imeis.join(',') }, { simulate: () => [] });
}

// ─── Lock date ─────────────────────────────────────────────────────────────

export interface RepayInfo {
  imei: string;
  deviceTag?: string | null;
  nextRepayTime: Date;
  nextRepayAmt?: number | null;
  repayedAmt?: number | null;
  totalAmt?: number | null;
  currentTerm?: number | null;
  totalTerm?: number | null;
  orderNum?: string | null;
  phoneNum?: string | null;
  currencyType?: string;
  ruleNum?: number | null;
  deeplink?: string | null;
  deeplinkPkg?: string | null;
  description?: string;
}

/**
 * Move the phone's lock date. This is both "unlock" (a future date) and
 * "lock" (a date a minute from now) — PayTrigger has no direct lock call.
 * PayTrigger refuses a date in the past.
 */
export function updateRepayInfo(info: RepayInfo) {
  return postAction<void>(
    'action',
    PATHS.updateRepayInfo,
    {
      imei: info.imei,
      deviceTag: info.deviceTag,
      nextRepayTime: toSeconds(info.nextRepayTime),
      nextRepayAmt: money(info.nextRepayAmt),
      repayedAmt: money(info.repayedAmt),
      totalAmt: money(info.totalAmt),
      currentTerm: info.currentTerm ?? undefined,
      totalTerm: info.totalTerm ?? undefined,
      orderNum: info.orderNum,
      phoneNum: info.phoneNum,
      currencyType: info.currencyType,
      ruleNum: info.ruleNum ?? undefined,
      deeplink: info.deeplink,
      deeplinkPkg: info.deeplink ? info.deeplinkPkg : undefined,
      description: info.description,
    },
    { keyField: 'relatedMerchant' },
  );
}

/** Permanent: the PayTrigger app uninstalls itself. Only after the contract is paid off. */
export function removeLock(device: { imei: string; deviceTag?: string | null }) {
  return postAction<void>('action', PATHS.removeLock, { imei: device.imei, deviceTag: device.deviceTag });
}

// ─── Status (reads) ────────────────────────────────────────────────────────

export interface LockState {
  deviceTag?: string;
  imei?: string;
  orderNum?: string | null;
  lockState?: number; // 0 unregistered · 1000 registered · 2000 ready · 3000 active · 5000 removable
  serverState?: number;
  mobileStatus?: number; // 1000 locked · 2000 unlocked (what the phone reports)
  serverLockStatus?: number;
  activeTime?: number | null;
  expiration?: number | null;
  lastConnectTime?: number | null;
  lockRuleNum?: number;
  apkVersion?: string;
  frameworkVersion?: string;
  model?: string;
  partnersPkgState?: string;
}

/** 100 reads per device per 24h; we use at most a couple. */
export function findLockState(device: { imei: string; deviceTag?: string | null }) {
  return postAction<LockState>('read', PATHS.findLockState, { imei: device.imei, deviceTag: device.deviceTag });
}

/** Up to 100 IMEIs per call; 100 calls per 24h. */
export function batchFindLockState(imeis: string[]) {
  return postAction<LockState[]>('read', PATHS.batchFindLockState, { imei: imeis.slice(0, 100).join(',') }, { simulate: () => [] });
}

export function getDevice(imei: string) {
  return postAction<{ deviceTag?: string; lockState?: number; serverState?: number; orderNum?: string }>(
    'read', PATHS.getDevice, { imei },
  );
}

export function getModel(imei: string) {
  return postAction<{ imei?: string; brandName?: string; modelLabelName?: string; modelMarketName?: string; ram?: number; rom?: number }>(
    'read', PATHS.getModel, { imei },
  );
}

export function checkLicence() {
  return postAction<{ totalAmountOfLicense?: number; amountUsedOfLicense?: number; remainingAmountOfLicense?: number }>(
    'read', PATHS.checkLicence, {},
  );
}

export function getCompanyConfig() {
  return postAction<Record<string, unknown>>('read', PATHS.companyConfig, {});
}

// ─── Lock-screen text and ladder ───────────────────────────────────────────

/** Per-device title and text — used for the "contact your agent" message while the deposit is unpaid. */
export function setDeviceRule(rule: {
  imei: string;
  deviceTag?: string | null;
  ruleNum: number;
  deviceTitle?: string;
  deviceTips?: string;
  deeplink?: string | null;
  deeplinkPkg?: string | null;
}) {
  return postAction<void>('action', PATHS.setLockRule, {
    imei: rule.imei,
    deviceTag: rule.deviceTag,
    ruleNum: rule.ruleNum,
    deviceTitle: rule.deviceTitle,
    deviceTips: rule.deviceTips?.slice(0, 400),
    deeplink: rule.deeplink,
    deeplinkPkg: rule.deeplink ? rule.deeplinkPkg : undefined,
  });
}

/** One restriction stage: on/off and how long after the due date it starts. */
export interface LadderStage {
  enabled: boolean;
  afterDays: number;
  title?: string;
  text?: string;
}

export interface Ladder {
  ruleNum: number;
  description?: string;
  watermark: LadderStage;
  autoPopup: LadderStage;
  callsOut: LadderStage;
  callsIn: LadderStage;
  sms: LadderStage;
  apps: LadderStage;
  screen: LadderStage;
}

/** execTime is in seconds and PayTrigger only accepts whole days. */
const execTime = (days: number) => String(Math.max(0, Math.round(days)) * 86400);

export function updateLadder(ladder: Ladder) {
  return postAction<void>('action', PATHS.updateLadder, {
    ruleNum: ladder.ruleNum,
    strategyDesc: ladder.description,
    watermarkSwitch: ladder.watermark.enabled,
    watermarkContent: [{ execContent: ladder.watermark.text || '', execTime: execTime(ladder.watermark.afterDays) }],
    autoPopupSwitch: ladder.autoPopup.enabled,
    autoPopupContent: [{ execContent: ladder.autoPopup.text || '', execTime: execTime(ladder.autoPopup.afterDays), title: ladder.autoPopup.title || '' }],
    callsOutSwitch: ladder.callsOut.enabled,
    callsOutContent: { execTime: execTime(ladder.callsOut.afterDays) },
    callsInSwitch: ladder.callsIn.enabled,
    callsInContent: { execTime: execTime(ladder.callsIn.afterDays) },
    smsBlockedSwitch: ladder.sms.enabled,
    smsBlockedContent: { execTime: execTime(ladder.sms.afterDays) },
    appBlockedSwitch: ladder.apps.enabled,
    appBlockedContent: [{ blockAllApp: true, execContent: '', execTime: execTime(ladder.apps.afterDays) }],
    screenBlockedSwitch: ladder.screen.enabled,
    screenBlockedContent: { execContent: ladder.screen.text || '', execTime: execTime(ladder.screen.afterDays), title: ladder.screen.title || '' },
    simBlockedSwitch: false,
  });
}

export function updateBranding(branding: {
  companyName?: string;
  logoUrl?: string;
  callInPhoneNum?: string;
  callOutPhoneNum?: string;
  customerServiceNumbers?: Array<{ countryName: string; number: string }>;
}) {
  return postAction<void>('action', PATHS.updateBranding, {
    companyName: branding.companyName,
    logoUrl: branding.logoUrl,
    callInPhoneNum: branding.callInPhoneNum,
    callOutPhoneNum: branding.callOutPhoneNum,
    customerServiceNumList: branding.customerServiceNumbers?.length ? branding.customerServiceNumbers : undefined,
  });
}

// ─── Offline PIN ───────────────────────────────────────────────────────────

/**
 * A 9-digit code the customer types on the lock screen. It carries the lock
 * date PayTrigger holds right now, so push the new date first.
 * Phones on PayTrigger app below V2.2.6.004 need the 4-digit key (captcha)
 * shown on their lock screen.
 */
export function issuePin(device: { imei: string; deviceTag?: string | null; captcha?: string }) {
  return postAction<{ verifyCode?: string }>(
    'action',
    PATHS.issuePin,
    { imei: device.imei, deviceTag: device.deviceTag, captcha: device.captcha },
    { simulate: () => ({ verifyCode: '000000000' }) },
  );
}

import { IndicatorKey, INDICATOR_BY_KEY, PayoutType } from './definitions';

/**
 * Turning a leader's measured values into money. Pure: no database, so the
 * fixtures can pin every rule down.
 *
 *   RATE      value × rate%                      (GHS indicators)
 *   PER_UNIT  count × amount                     (count indicators)
 *   TARGET    a flat amount when the target is met
 *   TIERS     the best tier reached pays its amount
 *
 * Negative amounts are deductions. A cap limits a line either way. The total
 * never goes below zero — a bad month earns nothing, it does not create a debt.
 */

export interface IndicatorRule {
  key: IndicatorKey;
  enabled: boolean;
  payoutType: PayoutType;
  rate: number;
  unitAmount: number;
  target: number | null;
  targetDirection: 'GTE' | 'LTE';
  targetAmount: number;
  tiers: Array<{ threshold: number; amount: number }> | null;
  cap: number | null;
}

export interface ScorecardSettings {
  baseAmount: number;
  parGateEnabled: boolean;
  parGateCeiling: number;
  gateWithholdsBase: boolean;
}

export interface MeasuredValue {
  key: IndicatorKey;
  /** null when it cannot be measured (e.g. PAR on an empty book). */
  value: number | null;
  count: number;
}

export interface PayoutLine {
  key: IndicatorKey;
  value: number | null;
  count: number;
  payout: number;
  explanation: string;
}

export interface PayoutResult {
  lines: PayoutLine[];
  base: number;
  variable: number;
  deductions: number;
  total: number;
  gated: boolean;
  gateReason: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `GHS ${round2(n).toFixed(2)}`;
const fmt = (key: IndicatorKey, v: number) => {
  const unit = INDICATOR_BY_KEY.get(key)?.unit;
  if (unit === 'GHS') return money(v);
  if (unit === 'PERCENT') return `${round2(v)}%`;
  return String(round2(v));
};

function meets(value: number, threshold: number, direction: 'GTE' | 'LTE') {
  return direction === 'GTE' ? value >= threshold : value <= threshold;
}

function applyCap(amount: number, cap: number | null): number {
  if (cap === null || cap === undefined || cap < 0) return amount;
  return amount >= 0 ? Math.min(amount, cap) : Math.max(amount, -cap);
}

export function linePayout(rule: IndicatorRule, measured: MeasuredValue): PayoutLine {
  const base = { key: rule.key, value: measured.value, count: measured.count };
  if (!rule.enabled) return { ...base, payout: 0, explanation: 'Not paid' };
  if (measured.value === null) return { ...base, payout: 0, explanation: 'Nothing to measure this month' };
  const v = measured.value;

  let amount = 0;
  let explanation = '';
  switch (rule.payoutType) {
    case 'RATE':
      amount = (v * rule.rate) / 100;
      explanation = `${fmt(rule.key, v)} × ${rule.rate}%`;
      break;
    case 'PER_UNIT':
      amount = measured.count * rule.unitAmount;
      explanation = `${measured.count} × ${money(rule.unitAmount)}`;
      break;
    case 'TARGET': {
      if (rule.target === null || rule.target === undefined) {
        explanation = 'No target set';
        break;
      }
      const ok = meets(v, rule.target, rule.targetDirection);
      amount = ok ? rule.targetAmount : 0;
      explanation = `${fmt(rule.key, v)} ${ok ? 'met' : 'missed'} target ${rule.targetDirection === 'GTE' ? '≥' : '≤'} ${fmt(rule.key, rule.target)}`;
      break;
    }
    case 'TIERS': {
      const tiers = [...(rule.tiers || [])].filter((t) => Number.isFinite(t.threshold) && Number.isFinite(t.amount));
      // Best tier reached: the highest threshold met when higher is better,
      // the lowest when lower is better.
      tiers.sort((a, b) => (rule.targetDirection === 'GTE' ? b.threshold - a.threshold : a.threshold - b.threshold));
      const hit = tiers.find((t) => meets(v, t.threshold, rule.targetDirection));
      amount = hit ? hit.amount : 0;
      explanation = hit
        ? `${fmt(rule.key, v)} reached tier ${rule.targetDirection === 'GTE' ? '≥' : '≤'} ${fmt(rule.key, hit.threshold)}`
        : `${fmt(rule.key, v)} reached no tier`;
      break;
    }
  }

  const capped = applyCap(amount, rule.cap);
  if (capped !== amount) explanation += ` (capped at ${money(Math.abs(rule.cap as number))})`;
  return { ...base, payout: round2(capped), explanation };
}

export function applyRules(measured: MeasuredValue[], rules: IndicatorRule[], settings: ScorecardSettings): PayoutResult {
  const byKey = new Map(measured.map((m) => [m.key, m]));
  const lines = rules.map((rule) => linePayout(rule, byKey.get(rule.key) ?? { key: rule.key, value: null, count: 0 }));

  const par = byKey.get('PAR30')?.value ?? null;
  const gated = settings.parGateEnabled && par !== null && par > settings.parGateCeiling;
  const gateReason = gated ? `PAR30 ${round2(par as number)}% is above the ${settings.parGateCeiling}% ceiling` : null;

  const positive = lines.reduce((s, l) => s + Math.max(0, l.payout), 0);
  const negative = lines.reduce((s, l) => s + Math.min(0, l.payout), 0);
  const base = gated && settings.gateWithholdsBase ? 0 : settings.baseAmount;
  const variable = gated ? 0 : positive;
  const total = Math.max(0, base + variable + negative);

  return {
    lines,
    base: round2(base),
    variable: round2(variable),
    deductions: round2(negative),
    total: round2(total),
    gated,
    gateReason,
  };
}

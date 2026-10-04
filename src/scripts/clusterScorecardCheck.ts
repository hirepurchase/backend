/**
 * npm run scorecard:check
 *
 * Offline fixtures for the cluster leader scorecard payout rules. No database.
 */
import assert from 'assert';
import { applyRules, IndicatorRule, linePayout, MeasuredValue } from '../services/clusterScorecard/payout';
import { IndicatorKey } from '../services/clusterScorecard/definitions';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`  ✘ ${name}\n      ${err?.message || err}`);
  }
}

const rule = (key: IndicatorKey, patch: Partial<IndicatorRule>): IndicatorRule => ({
  key,
  enabled: true,
  payoutType: 'RATE',
  rate: 0,
  unitAmount: 0,
  target: null,
  targetDirection: 'GTE',
  targetAmount: 0,
  tiers: null,
  cap: null,
  ...patch,
});
const val = (key: IndicatorKey, value: number | null, count = 0): MeasuredValue => ({ key, value, count });
const settings = { baseAmount: 0, parGateEnabled: false, parGateCeiling: 25, gateWithholdsBase: false };

console.log('Rules');
check('RATE: 2% of GHS 12,500 collected = 250', () =>
  assert.strictEqual(linePayout(rule('COLLECTIONS', { rate: 2 }), val('COLLECTIONS', 12500, 40)).payout, 250));
check('PER_UNIT: 7 new contracts × GHS 15 = 105', () =>
  assert.strictEqual(linePayout(rule('NEW_CONTRACTS', { payoutType: 'PER_UNIT', unitAmount: 15 }), val('NEW_CONTRACTS', 7, 7)).payout, 105));
check('TARGET met (≥): collection rate 92% vs 90% pays 300', () =>
  assert.strictEqual(linePayout(rule('COLLECTION_RATE', { payoutType: 'TARGET', target: 90, targetAmount: 300 }), val('COLLECTION_RATE', 92)).payout, 300));
check('TARGET exactly on the line counts as met', () =>
  assert.strictEqual(linePayout(rule('COLLECTION_RATE', { payoutType: 'TARGET', target: 90, targetAmount: 300 }), val('COLLECTION_RATE', 90)).payout, 300));
check('TARGET missed pays 0', () =>
  assert.strictEqual(linePayout(rule('COLLECTION_RATE', { payoutType: 'TARGET', target: 90, targetAmount: 300 }), val('COLLECTION_RATE', 89.99)).payout, 0));
check('TARGET (≤): PAR30 8% vs ceiling 10% pays', () =>
  assert.strictEqual(linePayout(rule('PAR30', { payoutType: 'TARGET', target: 10, targetDirection: 'LTE', targetAmount: 200 }), val('PAR30', 8)).payout, 200));

const tiersUp = rule('COLLECTION_RATE', { payoutType: 'TIERS', tiers: [{ threshold: 80, amount: 100 }, { threshold: 90, amount: 250 }, { threshold: 95, amount: 400 }] });
check('TIERS (≥): 93% reaches the 90% tier → 250', () => assert.strictEqual(linePayout(tiersUp, val('COLLECTION_RATE', 93)).payout, 250));
check('TIERS (≥): exactly 95% reaches the top tier → 400', () => assert.strictEqual(linePayout(tiersUp, val('COLLECTION_RATE', 95)).payout, 400));
check('TIERS (≥): 79% reaches no tier → 0', () => assert.strictEqual(linePayout(tiersUp, val('COLLECTION_RATE', 79)).payout, 0));
check('TIERS order in the list does not matter', () =>
  assert.strictEqual(linePayout({ ...tiersUp, tiers: [...tiersUp.tiers!].reverse() }, val('COLLECTION_RATE', 93)).payout, 250));
const tiersDown = rule('PAR30', { payoutType: 'TIERS', targetDirection: 'LTE', tiers: [{ threshold: 20, amount: 50 }, { threshold: 10, amount: 150 }, { threshold: 5, amount: 300 }] });
check('TIERS (≤): PAR 7% reaches the ≤10% tier → 150', () => assert.strictEqual(linePayout(tiersDown, val('PAR30', 7)).payout, 150));
check('TIERS (≤): PAR 4% reaches the best tier → 300', () => assert.strictEqual(linePayout(tiersDown, val('PAR30', 4)).payout, 300));
check('TIERS (≤): PAR 22% reaches no tier → 0', () => assert.strictEqual(linePayout(tiersDown, val('PAR30', 22)).payout, 0));

check('cap limits a positive line', () =>
  assert.strictEqual(linePayout(rule('COLLECTIONS', { rate: 5, cap: 500 }), val('COLLECTIONS', 20000)).payout, 500));
check('cap limits a deduction too', () =>
  assert.strictEqual(linePayout(rule('UNLOCKS_DEFAULTED', { payoutType: 'PER_UNIT', unitAmount: -50, cap: 100 }), val('UNLOCKS_DEFAULTED', 4, 4)).payout, -100));
check('negative per-unit amount is a deduction', () =>
  assert.strictEqual(linePayout(rule('UNLOCKS_DEFAULTED', { payoutType: 'PER_UNIT', unitAmount: -50 }), val('UNLOCKS_DEFAULTED', 2, 2)).payout, -100));
check('disabled indicator pays nothing', () =>
  assert.strictEqual(linePayout(rule('COLLECTIONS', { enabled: false, rate: 10 }), val('COLLECTIONS', 1000)).payout, 0));
check('unmeasurable value (PAR on an empty book) pays nothing', () =>
  assert.strictEqual(linePayout(rule('PAR30', { payoutType: 'TARGET', target: 10, targetDirection: 'LTE', targetAmount: 200 }), val('PAR30', null)).payout, 0));
check('TARGET with no target set pays nothing', () =>
  assert.strictEqual(linePayout(rule('COLLECTION_RATE', { payoutType: 'TARGET', targetAmount: 300 }), val('COLLECTION_RATE', 99)).payout, 0));
check('amounts round to pesewas', () =>
  assert.strictEqual(linePayout(rule('COLLECTIONS', { rate: 1.5 }), val('COLLECTIONS', 333.33)).payout, 5));

console.log('Totals and the PAR gate');
const rules = [
  rule('COLLECTIONS', { rate: 2 }),
  rule('NEW_CONTRACTS', { payoutType: 'PER_UNIT', unitAmount: 20 }),
  rule('UNLOCKS_DEFAULTED', { payoutType: 'PER_UNIT', unitAmount: -50 }),
  rule('PAR30', { enabled: false }),
];
const month = [val('COLLECTIONS', 10000), val('NEW_CONTRACTS', 5, 5), val('UNLOCKS_DEFAULTED', 1, 1), val('PAR30', 30)];
check('base + variable + deductions', () => {
  const r = applyRules(month, rules, { ...settings, baseAmount: 300 });
  assert.deepStrictEqual([r.base, r.variable, r.deductions, r.total, r.gated], [300, 300, -50, 550, false]);
});
check('PAR gate zeroes variable pay, keeps base and deductions', () => {
  const r = applyRules(month, rules, { ...settings, baseAmount: 300, parGateEnabled: true, parGateCeiling: 25 });
  assert.deepStrictEqual([r.base, r.variable, r.deductions, r.total, r.gated], [300, 0, -50, 250, true]);
  assert.ok(r.gateReason?.includes('30%'));
});
check('PAR gate can withhold the base as well', () => {
  const r = applyRules(month, rules, { ...settings, baseAmount: 300, parGateEnabled: true, parGateCeiling: 25, gateWithholdsBase: true });
  assert.deepStrictEqual([r.base, r.variable, r.total], [0, 0, 0]);
});
check('PAR at the ceiling does not trip the gate', () => {
  const r = applyRules([...month.slice(0, 3), val('PAR30', 25)], rules, { ...settings, parGateEnabled: true, parGateCeiling: 25 });
  assert.strictEqual(r.gated, false);
});
check('PAR gate ignores a leader with no book', () => {
  const r = applyRules([...month.slice(0, 3), val('PAR30', null)], rules, { ...settings, parGateEnabled: true });
  assert.strictEqual(r.gated, false);
});
check('deductions never push the total below zero', () => {
  const r = applyRules([val('UNLOCKS_DEFAULTED', 10, 10)], rules, settings);
  assert.deepStrictEqual([r.deductions, r.total], [-500, 0]);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

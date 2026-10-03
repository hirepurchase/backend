/**
 * npm run paytrigger:check
 *
 * Offline self-test for the PayTrigger sidecar. Touches no database and no
 * handset: forces dry-run, reproduces the API doc's signing example byte for
 * byte, runs every client call in simulation, and runs the decision fixtures.
 */
process.env.PAYTRIGGER_DRY_RUN = 'true';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'false';

import assert from 'assert';
import { buildSignContent, flatten, sign, verifyCallback } from '../services/payTrigger/sign';
import * as client from '../services/payTrigger/client';

let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`  ✘ ${name}\n      ${err?.message || err}`);
  }
}

async function signing() {
  console.log('Signing (API doc §5 Q1 example)');
  const docKey = '8qXIGKndpecSDmlLF1HaQ0fN6AREjvs4';
  const body = flatten({
    imeiInfo: '[{"expiration":1662136801,"imei":"359581820772412","model":"infinix SMART 6","ram":"2","rom":"32"}]',
    preLockFlag: 'false',
    apiKey: docKey,
  });

  await check('sign content is ASCII-sorted k=v joined by &', () =>
    assert.strictEqual(
      buildSignContent(body),
      'apiKey=8qXIGKndpecSDmlLF1HaQ0fN6AREjvs4&imeiInfo=[{"expiration":1662136801,"imei":"359581820772412","model":"infinix SMART 6","ram":"2","rom":"32"}]&preLockFlag=false',
    ));
  await check('sign matches the doc (BB76C482…1AA7 → base64)', () =>
    assert.strictEqual(
      sign(body, docKey),
      'QkI3NkM0ODIzN0NDQzJBM0I2REY1RUY5MjgzRTkxQUNGRTk4M0VFOTY0QzlCMzRGNUYzRTE2OTFGMzgzMUFBNw==',
    ));
  await check('boolean true/false signs the same as the string', () =>
    assert.strictEqual(sign(flatten({ ...body, preLockFlag: false }), docKey), sign(body, docKey)));
  await check('empty values are left out of the signature', () =>
    assert.strictEqual(sign(flatten({ ...body, orderNum: '', deviceTag: null }), docKey), sign(body, docKey)));
  await check('callback signature verifies, and a tampered one does not', () => {
    const cb = { imei: '359581820772412', notifyType: 1000, mobileStatus: 1000 };
    const header = sign(flatten(cb), docKey);
    assert.ok(verifyCallback(header, cb, docKey));
    assert.ok(!verifyCallback(header, { ...cb, mobileStatus: 2000 }, docKey));
    assert.ok(!verifyCallback(undefined, cb, docKey));
  });
}

async function dryRunClient() {
  console.log('Client calls in dry run');
  const device = { imei: '359581820772412', deviceTag: 'ABCD1234' };
  const calls: Array<[string, () => Promise<client.PayTriggerResult>]> = [
    ['enrolImeis', () => client.enrolImeis([{ imei: device.imei, orderNum: 'CON1' }])],
    ['cancelEnrolment', () => client.cancelEnrolment([device.imei])],
    ['updateRepayInfo', () => client.updateRepayInfo({ ...device, nextRepayTime: new Date(Date.now() + 86400000) })],
    ['removeLock', () => client.removeLock(device)],
    ['setDeviceRule', () => client.setDeviceRule({ ...device, ruleNum: 0, deviceTitle: 't', deviceTips: 'x' })],
    ['updateLadder', () => client.updateLadder({
      ruleNum: 0,
      watermark: { enabled: true, afterDays: 0 }, autoPopup: { enabled: true, afterDays: 0 },
      callsOut: { enabled: false, afterDays: 0 }, callsIn: { enabled: false, afterDays: 0 },
      sms: { enabled: false, afterDays: 0 }, apps: { enabled: true, afterDays: 3 }, screen: { enabled: true, afterDays: 5 },
    })],
    ['updateBranding', () => client.updateBranding({ companyName: 'Aidoo Tech' })],
    ['issuePin', () => client.issuePin(device)],
    ['findLockState', () => client.findLockState(device)],
    ['batchFindLockState', () => client.batchFindLockState([device.imei])],
    ['getDevice', () => client.getDevice(device.imei)],
    ['getModel', () => client.getModel(device.imei)],
    ['checkLicence', () => client.checkLicence()],
  ];
  for (const [name, call] of calls) {
    await check(`${name} is simulated`, async () => {
      const result = await call();
      assert.ok(result.success && result.dryRun, JSON.stringify(result));
      assert.ok(!JSON.stringify(result.request).includes(process.env.PAYTRIGGER_API_KEY || '\u0000'), 'api key leaked into request log');
    });
  }
  await check('updateRepayInfo sends the key as relatedMerchant, never apiKey', async () => {
    const result = await client.updateRepayInfo({ ...device, nextRepayTime: new Date(Date.now() + 86400000) });
    assert.ok('relatedMerchant' in (result.request || {}));
    assert.ok(!('apiKey' in (result.request || {})));
  });
}

async function main() {
  await signing();
  await dryRunClient();
  try {
    const { runDecisionFixtures } = await import('./payTriggerDecisionFixtures');
    console.log('Decision fixtures');
    await runDecisionFixtures(check);
  } catch (err: any) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main();

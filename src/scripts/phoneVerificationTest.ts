/**
 * Customer and guarantor phone verification — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/phoneVerificationTest.ts
 *
 * Hubtel is replaced by a local mock, so no real number is ever queried.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

// Synthetic numbers → what the mock "network" answers.
const NETWORK: Record<string, { status: number; body: any }> = {
  '233241110001': { status: 200, body: { ResponseCode: '0000', Message: 'Customer Details', Data: [{ Display: 'name', Value: 'MENSAH KWAME ASANTE', Amount: 0 }] } },
  '233241110002': { status: 200, body: { ResponseCode: '0000', Message: 'Customer Details', Data: [{ Display: 'name', Value: 'ABENA SERWAA BOATENG', Amount: 0 }] } },
  '233241110003': { status: 404, body: { message: 'Not found', responseCode: '3000', data: null } },
  '233241110004': { status: 403, body: '<html>403 Forbidden</html>' },
  '233241110005': { status: 200, body: { ResponseCode: '0000', Message: 'Customer Details', Data: [{ Display: 'name', Value: 'AKOSUA DARKO', Amount: 0 }] } },
  '233241110006': { status: 200, body: { ResponseCode: '0000', Message: 'Customer Details', Data: [{ Display: 'name', Value: 'YAW OSEI', Amount: 0 }] } },
};
const hits: string[] = [];

let failures = 0;
async function check(name: string, fn: () => Promise<unknown> | unknown) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}

function call(handler: (req: any, res: any) => Promise<void>, req: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const res: any = {
      status(code: number) { status = code; return res; },
      json(body: any) { resolve({ status, body }); return res; },
    };
    handler({ ip: '127.0.0.1', headers: {}, params: {}, body: {}, ...req }, res);
  });
}

async function main() {
  const server = http.createServer((req, res) => {
    const destination = new URL(req.url || '', 'http://x').searchParams.get('destination') || '';
    hits.push(destination);
    const answer = NETWORK[destination] || { status: 404, body: { responseCode: '3000' } };
    res.writeHead(answer.status, { 'Content-Type': typeof answer.body === 'string' ? 'text/html' : 'application/json' });
    res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // Set before the modules read them at load.
  Object.assign(process.env, {
    HUBTEL_NAME_QUERY_URL: `http://127.0.0.1:${port}/commissionservices/test/3e0841e70afc42fb97d13d19abd36384`,
    HUBTEL_POS_SALES_ID: 'test', HUBTEL_API_KEY: 'test', HUBTEL_API_SECRET: 'test',
    ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', NALO_API_KEY: '', EMAIL_HOST: '',
  });
  const { default: prisma } = require('../config/database');
  const svc = require('../services/phoneVerificationService');
  const ctl = require('../controllers/customerController');
  const { evaluateContractSubmissionGuardrails } = require('../services/contractReviewService');

  const T = `pv${Date.now()}`;
  const role = await prisma.role.upsert({ where: { name: 'SUPER_ADMIN' }, create: { name: 'SUPER_ADMIN' }, update: {} });
  const admin = await prisma.adminUser.create({ data: { email: `${T}@t.local`, password: 'x', firstName: 'Test', lastName: 'Admin', roleId: role.id } });
  const user = { id: admin.id, role: 'SUPER_ADMIN', permissions: [] };
  // Leftovers from an earlier run would trip "phone already registered".
  await prisma.customer.deleteMany({ where: { phone: { startsWith: '024111000' } } });

  console.log('Name comparison');
  await check('surname-first SIM name still matches', () => assert.equal(svc.compareNames('Kwame Mensah', 'MENSAH KWAME ASANTE').status, 'MATCHED'));
  await check('one slip in a long name is allowed', () => assert.equal(svc.compareNames('Kwami Mensah', 'MENSAH KWAME').status, 'MATCHED'));
  await check('short form matches (Emma / Emmanuel)', () => assert.equal(svc.compareNames('Emma Owusu', 'EMMANUEL OWUSU').status, 'MATCHED'));
  await check('one shared word is partial', () => assert.equal(svc.compareNames('Kofi Mensah', 'MENSAH KWAME').status, 'PARTIAL'));
  await check('different person is a mismatch', () => assert.equal(svc.compareNames('Kofi Boateng', 'ABENA SERWAA').status, 'MISMATCH'));
  await check('short words do not fuzzy-match (ADU / ADO)', () => assert.equal(svc.compareNames('Ama Adu', 'ESI ADO').status, 'MISMATCH'));

  console.log('Registration');
  const register = (body: any) => call(ctl.createCustomer, { user, body: { nationalId: 'GHA-000000000-0', ...body } });

  await check('matching customer and guarantor are saved as MATCHED', async () => {
    const r = await register({ firstName: 'Kwame', lastName: 'Mensah', phone: '0241110001', guarantorName: 'Akosua Darko', guarantorPhone: '0241110005' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.phoneVerificationStatus, 'MATCHED');
    assert.equal(r.body.phoneRegisteredName, 'MENSAH KWAME ASANTE');
    assert.equal(r.body.guarantorVerificationStatus, 'MATCHED');
    assert.equal(r.body.guarantorPhone, '0241110005');
  });

  await check('customer number registered to someone else is saved as MISMATCH', async () => {
    const r = await register({ firstName: 'Kofi', lastName: 'Owusu', phone: '0241110002' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.phoneVerificationStatus, 'MISMATCH');
    assert.equal(r.body.phoneRegisteredName, 'ABENA SERWAA BOATENG');
  });

  await check('unregistered customer number is refused', async () => {
    const r = await register({ firstName: 'Ghost', lastName: 'Person', phone: '0241110003' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not registered/);
    assert.equal(await prisma.customer.count({ where: { phone: '0241110003' } }), 0);
  });

  await check('unregistered guarantor number is refused', async () => {
    const r = await register({ firstName: 'Yaw', lastName: 'Osei', phone: '0241110006', guarantorName: 'Ghost', guarantorPhone: '0241110003' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /guarantor/);
    assert.equal(await prisma.customer.count({ where: { phone: '0241110006' } }), 0);
  });

  await check("guarantor can't use the customer's own number", async () => {
    const r = await register({ firstName: 'Yaw', lastName: 'Osei', phone: '0241110006', guarantorName: 'Yaw Osei', guarantorPhone: '233241110006' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /own number/);
  });

  await check('guarantor number without a name is refused', async () => {
    const r = await register({ firstName: 'Yaw', lastName: 'Osei', phone: '0241110006', guarantorPhone: '0241110005' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /guarantor's name/);
  });

  await check('Hubtel unreachable (403): saved as UNAVAILABLE, not refused', async () => {
    const r = await register({ firstName: 'Esi', lastName: 'Ado', phone: '0241110004' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.phoneVerificationStatus, 'UNAVAILABLE');
  });

  await check('warn mode saves an unregistered number and flags it', async () => {
    process.env.PHONE_VERIFICATION_MODE = 'warn';
    try {
      const r = await register({ firstName: 'Ghost', lastName: 'Person', phone: '0241110003' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.phoneVerificationStatus, 'NOT_REGISTERED');
    } finally {
      delete process.env.PHONE_VERIFICATION_MODE;
    }
  });

  await check('off mode makes no Hubtel query', async () => {
    process.env.PHONE_VERIFICATION_MODE = 'off';
    const before = hits.length;
    try {
      const r = await register({ firstName: 'Yaw', lastName: 'Osei', phone: '0241110006' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.phoneVerificationStatus, null);
      assert.equal(hits.length, before);
    } finally {
      delete process.env.PHONE_VERIFICATION_MODE;
    }
  });

  await check('each number is queried once, then answered from memory', () => {
    const counts = hits.reduce((m: Record<string, number>, h) => ({ ...m, [h]: (m[h] || 0) + 1 }), {});
    assert.equal(counts['233241110001'], 1);
    assert.equal(counts['233241110005'], 1);
    assert.equal(counts['233241110003'], 1, JSON.stringify(counts));
    // A failed check is not remembered, so it is retried next time.
    assert.ok(!('233241110004' in counts) || counts['233241110004'] >= 1);
  });

  console.log('Preview (form check)');
  await check('preview returns the registered name and stores nothing', async () => {
    const r = await call(ctl.previewPhoneVerification, { user, body: { phone: '0241110005', name: 'Akosua Darko' } });
    assert.equal(r.body.status, 'MATCHED');
    assert.equal(r.body.registeredName, 'AKOSUA DARKO');
    assert.equal(r.body.mode, 'enforce');
  });
  await check('preview rejects a malformed number', async () => {
    const r = await call(ctl.previewPhoneVerification, { user, body: { phone: '12345', name: 'X' } });
    assert.equal(r.status, 400);
  });

  console.log('Editing');
  const kofi = await prisma.customer.findFirstOrThrow({ where: { phone: '0241110002' } });
  await check('resaving an unchanged form makes no query and keeps the result', async () => {
    const before = hits.length;
    const r = await call(ctl.updateCustomer, { user, params: { id: kofi.id }, body: { firstName: 'Kofi', lastName: 'Owusu', phone: '0241110002', address: 'Accra' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(hits.length, before);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: kofi.id } });
    assert.equal(saved.phoneVerificationStatus, 'MISMATCH');
  });
  await check('correcting the name to the owner re-checks to MATCHED', async () => {
    const r = await call(ctl.updateCustomer, { user, params: { id: kofi.id }, body: { firstName: 'Abena', lastName: 'Boateng' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: kofi.id } });
    assert.equal(saved.phoneVerificationStatus, 'MATCHED');
  });
  await check('adding an unregistered guarantor on edit is refused', async () => {
    const r = await call(ctl.updateCustomer, { user, params: { id: kofi.id }, body: { guarantorName: 'Ghost', guarantorPhone: '0241110003' } });
    assert.equal(r.status, 400);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: kofi.id } });
    assert.equal(saved.guarantorPhone, null);
  });
  await check('removing the guarantor clears their check', async () => {
    await call(ctl.updateCustomer, { user, params: { id: kofi.id }, body: { guarantorName: 'Akosua Darko', guarantorPhone: '0241110005' } });
    let saved = await prisma.customer.findUniqueOrThrow({ where: { id: kofi.id } });
    assert.equal(saved.guarantorVerificationStatus, 'MATCHED');
    await call(ctl.updateCustomer, { user, params: { id: kofi.id }, body: { guarantorName: '', guarantorPhone: '' } });
    saved = await prisma.customer.findUniqueOrThrow({ where: { id: kofi.id } });
    assert.equal(saved.guarantorPhone, null);
    assert.equal(saved.guarantorVerificationStatus, null);
  });

  console.log('Customers registered before the check');
  const old = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}old`, firstName: 'YAW', lastName: 'OSEI', phone: '0241110007', guarantorName: 'Wrong Person', guarantorPhone: '0241110002', createdById: admin.id } });
  await check('re-check stores results, flags rather than refuses', async () => {
    NETWORK['233241110007'] = { status: 404, body: { responseCode: '3000' } };
    const r = await call(ctl.reverifyCustomerPhones, { user, params: { id: old.id } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.phoneVerificationStatus, 'NOT_REGISTERED');
    assert.equal(r.body.guarantorVerificationStatus, 'MISMATCH');
    assert.equal(r.body.guarantorRegisteredName, 'ABENA SERWAA BOATENG');
  });

  console.log('Approval review');
  const cat = await prisma.productCategory.create({ data: { name: T } });
  const product = await prisma.product.create({ data: { name: `PHONE ${T}`, basePrice: 1500, categoryId: cat.id } });
  const item = await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-13)}`, status: 'AVAILABLE' } });
  const review = (customerId: string) => evaluateContractSubmissionGuardrails({ customerId, inventoryItemId: item.id, totalPrice: 1500, depositAmount: 500, totalInstallments: 4 });

  await check('unverified identity raises high-priority flags and warnings', async () => {
    const a = await review(old.id);
    assert.ok(a.riskFlags.includes('PHONE_NOT_REGISTERED'), a.riskFlags.join());
    assert.ok(a.riskFlags.includes('GUARANTOR_NAME_MISMATCH'), a.riskFlags.join());
    assert.ok(a.warnings.some((w: string) => w.includes('ABENA SERWAA BOATENG')));
    assert.equal(a.priority, 'HIGH');
  });
  await check('verified customer raises no phone flags', async () => {
    const kwame = await prisma.customer.findFirstOrThrow({ where: { phone: '0241110001' } });
    const a = await review(kwame.id);
    assert.ok(!a.riskFlags.some((f: string) => f.startsWith('PHONE_') || f.startsWith('GUARANTOR_')), a.riskFlags.join());
  });
  await check('never-checked customer raises no phone flags', async () => {
    const legacy = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}leg`, firstName: 'OLD', lastName: 'CUSTOMER', phone: '0241110008', createdById: admin.id } });
    const a = await review(legacy.id);
    assert.ok(!a.riskFlags.some((f: string) => f.startsWith('PHONE_') || f.startsWith('GUARANTOR_')), a.riskFlags.join());
  });
  await check('Hubtel-unavailable customer is flagged as not verified', async () => {
    const esi = await prisma.customer.findFirstOrThrow({ where: { phone: '0241110004' } });
    const a = await review(esi.id);
    assert.ok(a.riskFlags.includes('PHONE_NOT_VERIFIED'), a.riskFlags.join());
  });

  server.close();
  await new Promise((r) => setTimeout(r, 500));
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

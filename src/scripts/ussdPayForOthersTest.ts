/**
 * USSD menu: pay for self / pay for others — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/ussdPayForOthersTest.ts
 *
 * Hubtel's Receive Money is replaced by a local mock; no prompt is sent.
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

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}
const day = (o: number) => new Date(Date.now() + o * 86400_000);

async function main() {
  const prompts: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      prompts.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ResponseCode: '0001', Message: 'Transaction pending', Data: { TransactionId: `mock-${prompts.length}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    HUBTEL_RECEIVE_MONEY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/receive`,
    HUBTEL_POS_SALES_ID: 'test', HUBTEL_API_KEY: 'test', HUBTEL_API_SECRET: 'test',
    USSD_PROMPT_DELAY_MS: '50', ENABLE_SMS_NOTIFICATIONS: 'false', NALO_API_KEY: '',
  });
  const { default: prisma } = require('../config/database');
  const { handleUssdSession } = require('../controllers/paymentController');

  const dial = (body: any): Promise<any> => new Promise((resolve) => {
    const res: any = { status: () => res, json: (b: any) => resolve(b) };
    handleUssdSession({ body: { SessionId: 'S1', Operator: 'mtn', ClientState: '', ...body } }, res);
  });
  // Walks the menu from dialling, one answer per step; returns every screen.
  async function session(mobile: string, answers: string[]) {
    const screens: any[] = [await dial({ Type: 'Initiation', Mobile: mobile, Message: '*713*1#' })];
    for (const a of answers) {
      const last = screens[screens.length - 1];
      if (last.Type === 'release') break;
      screens.push(await dial({ Type: 'Response', Mobile: mobile, Message: a, ClientState: last.ClientState }));
    }
    return screens;
  }

  const T = `uo${Date.now()}`;
  const role = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${T}@t.local`, password: 'x', firstName: 'Test', lastName: 'Agent', roleId: role.id } });
  // Fresh numbers each run, so earlier runs' customers never collide.
  const n = String(Date.now()).slice(-6);
  const phones = { owner: `0551${n}`, relative: `0552${n}`, noContract: `0553${n}`, stranger: `0559${n}` };
  const intl = (p: string) => `233${p.slice(1)}`;
  const mk = (phone: string, first: string, last: string, isActivated = true) =>
    prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${phone}`, firstName: first, lastName: last, phone, isActivated, createdById: agent.id } });
  const owner = await mk(phones.owner, 'KWAME', 'MENSAH', false);
  await mk(phones.relative, 'ABENA', 'MENSAH');
  await mk(phones.noContract, 'YAW', 'OSEI');
  const contract = await prisma.hirePurchaseContract.create({ data: {
    contractNumber: `HP-${T}`, customerId_uuid: owner.id_uuid, totalPrice: 1500, depositAmount: 300, financeAmount: 1200, installmentAmount: 300,
    paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: day(-10), endDate: day(20), status: 'ACTIVE',
    outstandingBalance: 1200, totalPaid: 300, createdById: agent.id, approvedAt: day(-11) } });
  for (let i = 1; i <= 4; i++) {
    await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: i, amount: 300, dueDate: day(-7 + 7 * i), status: i === 1 ? 'PENDING' : 'PENDING' } });
  }

  await check('dialling shows pay for self / pay for others / cancel', async () => {
    const [first] = await session(phones.stranger, []);
    assert.equal(first.Type, 'response');
    assert.match(first.Message, /1\. Pay for self\n2\. Pay for others\n0\. Cancel/);
  });

  await check('pay for self: owner sees their own balance (not-yet-activated account included)', async () => {
    const s = await session(phones.owner, ['1']);
    assert.match(s[1].Message, /Hi KWAME/);
    assert.match(s[1].Message, /Bal: GHS 1200\.00/);
  });

  await check('pay for self: owner pays, prompt goes to the owner\'s number', async () => {
    const before = prompts.length;
    const s = await session(phones.owner, ['1', '1', '300']);
    assert.equal(s[3].Type, 'release');
    assert.match(s[3].Message, /GHS 300\.00/);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(prompts.length, before + 1);
    assert.equal(prompts[prompts.length - 1].CustomerMsisdn, intl(phones.owner));
    const p = await prisma.paymentTransaction.findFirstOrThrow({ where: { contractId: contract.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(JSON.parse(p.metadata).paidFor, 'SELF');
    assert.equal(p.status, 'PENDING');
  });

  await check('pay for self from an unregistered number offers pay for others or cancel', async () => {
    const s = await session(phones.stranger, ['1']);
    assert.equal(s[1].Type, 'response');
    assert.match(s[1].Message, /not registered\.\n1\. Pay for others\n0\. Cancel/);
  });

  await check('pay for self with no active contract offers pay for others or cancel', async () => {
    const s = await session(phones.noContract, ['1']);
    assert.match(s[1].Message, /no active hire purchase contract\.\n1\. Pay for others/);
  });

  await check('…then choosing pay for others pays for the relative from the dialling number', async () => {
    const before = prompts.length;
    const s = await session(phones.noContract, ['1', '1', phones.owner, '1', '150.50']);
    assert.match(s[2].Message, /registered phone number/);
    assert.match(s[3].Message, /For: KWAME M\. \(HP-/);
    assert.doesNotMatch(s[3].Message, /Hi KWAME/);
    assert.equal(s[5].Type, 'release');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(prompts.length, before + 1);
    // The prompt goes to whoever dialled, not to the customer.
    assert.equal(prompts[prompts.length - 1].CustomerMsisdn, intl(phones.noContract));
    const p = await prisma.paymentTransaction.findFirstOrThrow({ where: { contractId: contract.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(p.amount, 150.5);
    assert.equal(p.customerId_uuid, owner.id_uuid);
    const meta = JSON.parse(p.metadata);
    assert.equal(meta.paidFor, 'OTHER');
    assert.equal(meta.payerPhone, phones.noContract);
  });

  await check('…or choosing cancel ends the session', async () => {
    const s = await session(phones.stranger, ['1', '0']);
    assert.equal(s[2].Type, 'release');
    assert.match(s[2].Message, /Goodbye/);
  });

  await check('pay for others straight from the first menu', async () => {
    const s = await session(phones.relative, ['2', intl(phones.owner)]);
    assert.match(s[1].Message, /registered phone number/);
    assert.match(s[2].Message, /For: KWAME M\./);
  });

  await check('pay for others: unknown number ends with a clear message', async () => {
    const s = await session(phones.relative, ['2', '0559999999']);
    assert.equal(s[2].Type, 'release');
    assert.match(s[2].Message, /not recognised/);
  });

  await check('pay for others: customer with nothing to pay ends with a clear message', async () => {
    const s = await session(phones.relative, ['2', phones.noContract]);
    assert.equal(s[2].Type, 'release');
    assert.match(s[2].Message, /That customer has no active/);
  });

  await check('pay for others: amounts above what is owed are still refused', async () => {
    const s = await session(phones.relative, ['2', phones.owner, '1', '5000']);
    assert.equal(s[4].Type, 'release');
    assert.match(s[4].Message, /more than you owe/);
  });

  await check('cancel and invalid choices on the first menu', async () => {
    assert.match((await session(phones.owner, ['0']))[1].Message, /Goodbye/);
    assert.match((await session(phones.owner, ['7']))[1].Message, /Invalid option/);
  });

  await check('sessions opened before the deploy (old menus) still finish', async () => {
    const r1 = await dial({ Type: 'Response', Mobile: phones.stranger, Message: '1', ClientState: `UNREGISTERED|${phones.stranger}|MTN` });
    assert.match(r1.Message, /registered phone number/);
    const r2 = await dial({ Type: 'Response', Mobile: phones.stranger, Message: phones.owner, ClientState: `VERIFY|${phones.stranger}|MTN` });
    assert.match(r2.Message, /For: KWAME M\./);
    const oldAmount = `AMOUNT|${contract.id}|MTN|${owner.id_uuid}|KWAME MENSAH||${phones.owner}|HP-${T}`;
    const r3 = await dial({ Type: 'Response', Mobile: phones.owner, Message: '10', ClientState: oldAmount });
    assert.equal(r3.Type, 'release');
    assert.match(r3.Message, /GHS 10\.00/);
  });

  await new Promise((r) => setTimeout(r, 400));
  server.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

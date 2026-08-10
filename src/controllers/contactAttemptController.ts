import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { resolveCustomerScope, resolveContractScope, scopeAllows } from '../services/scopeService';

const PURPOSES = ['VERIFICATION', 'COLLECTION', 'FOLLOW_UP', 'OTHER'];
const OUTCOMES = [
  'REACHED',
  'NO_ANSWER',
  'WRONG_NUMBER',
  'UNREACHABLE',
  'PROMISE_TO_PAY',
  'REFUSED',
  'CALLBACK_REQUESTED',
];
const VERIFICATION_RESULTS = ['VERIFIED', 'FAILED', 'INCONCLUSIVE'];

function parseOptionalDate(value: unknown, label: string): { date: Date | null; error?: string } {
  if (value === undefined || value === null || value === '') {
    return { date: null };
  }
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) {
    return { date: null, error: `Invalid ${label}` };
  }
  return { date };
}

// POST /contact-attempts
export async function createContactAttempt(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const {
      customerId,
      contractId,
      installmentId,
      purpose,
      outcome,
      verificationResult,
      notes,
      promiseToPayDate,
      promiseToPayAmount,
      nextFollowUpAt,
    } = req.body;

    if (!customerId || !purpose || !outcome) {
      res.status(400).json({ error: 'Customer, purpose and outcome are required' });
      return;
    }

    if (!PURPOSES.includes(purpose)) {
      res.status(400).json({ error: `Invalid purpose. Expected one of: ${PURPOSES.join(', ')}` });
      return;
    }

    if (!OUTCOMES.includes(outcome)) {
      res.status(400).json({ error: `Invalid outcome. Expected one of: ${OUTCOMES.join(', ')}` });
      return;
    }

    if (verificationResult && !VERIFICATION_RESULTS.includes(verificationResult)) {
      res.status(400).json({ error: `Invalid verification result. Expected one of: ${VERIFICATION_RESULTS.join(', ')}` });
      return;
    }

    if (purpose === 'VERIFICATION' && !verificationResult) {
      res.status(400).json({ error: 'A verification call must record a verification result' });
      return;
    }

    // Admin routes address customers by `id`; every relation keys off `id_uuid`.
    const customer = await prisma.customer.findFirst({
      where: { OR: [{ id: String(customerId) }, { id_uuid: String(customerId) }] },
      select: { id: true, id_uuid: true, createdById: true },
    });

    if (!customer?.id_uuid) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const customerScope = await resolveCustomerScope(admin);
    if (!scopeAllows(customerScope, customer.createdById)) {
      res.status(403).json({ error: 'This customer belongs to an agent outside your assigned portfolio' });
      return;
    }

    let resolvedContractId: string | null = null;
    if (contractId) {
      const contract = await prisma.hirePurchaseContract.findUnique({
        where: { id: String(contractId) },
        select: { id: true, createdById: true, customerId_uuid: true },
      });

      if (!contract) {
        res.status(404).json({ error: 'Contract not found' });
        return;
      }

      if (contract.customerId_uuid !== customer.id_uuid) {
        res.status(400).json({ error: 'Contract does not belong to this customer' });
        return;
      }

      const contractScope = await resolveContractScope(admin);
      if (!scopeAllows(contractScope, contract.createdById)) {
        res.status(403).json({ error: 'This contract belongs to an agent outside your assigned portfolio' });
        return;
      }

      resolvedContractId = contract.id;
    }

    const promiseDate = parseOptionalDate(promiseToPayDate, 'promise to pay date');
    if (promiseDate.error) {
      res.status(400).json({ error: promiseDate.error });
      return;
    }

    const followUpDate = parseOptionalDate(nextFollowUpAt, 'follow up date');
    if (followUpDate.error) {
      res.status(400).json({ error: followUpDate.error });
      return;
    }

    if (outcome === 'PROMISE_TO_PAY' && !promiseDate.date) {
      res.status(400).json({ error: 'A promise to pay must record the date the customer promised' });
      return;
    }

    const attempt = await prisma.contactAttempt.create({
      data: {
        customerId_uuid: customer.id_uuid,
        contractId: resolvedContractId,
        installmentId: installmentId ? String(installmentId) : null,
        officerId: admin.id,
        purpose,
        outcome,
        verificationResult: verificationResult || null,
        notes: notes ? String(notes).trim() : null,
        promiseToPayDate: promiseDate.date,
        promiseToPayAmount:
          promiseToPayAmount !== undefined && promiseToPayAmount !== null && promiseToPayAmount !== ''
            ? Number(promiseToPayAmount)
            : null,
        nextFollowUpAt: followUpDate.date,
      },
    });

    await createAuditLog({
      userId: admin.id,
      // Verification calls surface on the contract approval timeline; other
      // calls are logged under a generic action.
      action: purpose === 'VERIFICATION' ? 'VERIFY_CUSTOMER_CALL' : 'LOG_CONTACT_ATTEMPT',
      entity: resolvedContractId ? 'HirePurchaseContract' : 'Customer',
      entityId: resolvedContractId || customer.id,
      newValues: {
        purpose,
        outcome,
        verificationResult: verificationResult || null,
        note: notes ? String(notes).trim() : null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.status(201).json({ message: 'Call logged', attempt });
  } catch (error) {
    console.error('createContactAttempt error:', error);
    res.status(500).json({ error: 'Failed to log call' });
  }
}

// GET /contact-attempts
export async function listContactAttempts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { page = 1, limit = 20, purpose, outcome, officerId, contractId, search, from, to } = req.query;

    const scope = await resolveCustomerScope(admin);
    const where: Record<string, unknown> = {};

    // Filter through the customer relation, since the attempt itself carries no
    // creator column.
    switch (scope.mode) {
      case 'all':
        break;
      case 'own':
        where.customer = { createdById: scope.userId };
        break;
      case 'assigned':
        where.customer = { createdById: { in: scope.agentIds } };
        break;
      case 'none':
        where.customer = { createdById: { in: [] } };
        break;
    }

    if (purpose) where.purpose = purpose as string;
    if (outcome) where.outcome = outcome as string;
    if (officerId) where.officerId = officerId as string;
    if (contractId) where.contractId = contractId as string;

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from as string);
      if (to) {
        const end = new Date(to as string);
        end.setHours(23, 59, 59, 999);
        range.lte = end;
      }
      where.contactedAt = range;
    }

    if (search) {
      where.OR = [
        { customer: { firstName: { contains: search as string, mode: 'insensitive' } } },
        { customer: { lastName: { contains: search as string, mode: 'insensitive' } } },
        { customer: { phone: { contains: search as string, mode: 'insensitive' } } },
        { customer: { membershipId: { contains: search as string, mode: 'insensitive' } } },
        { contract: { contractNumber: { contains: search as string, mode: 'insensitive' } } },
        { notes: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const take = Math.min(Number(limit) || 20, 100);
    const skip = ((Number(page) || 1) - 1) * take;

    const [attempts, total, byOutcome] = await Promise.all([
      prisma.contactAttempt.findMany({
        where,
        include: {
          customer: { select: { id: true, membershipId: true, firstName: true, lastName: true, phone: true } },
          contract: { select: { id: true, contractNumber: true } },
          officer: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { contactedAt: 'desc' },
        skip,
        take,
      }),
      prisma.contactAttempt.count({ where }),
      prisma.contactAttempt.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
    ]);

    res.json({
      attempts,
      summary: Object.fromEntries(byOutcome.map((row) => [row.outcome, row._count._all])),
      pagination: { page: Number(page) || 1, limit: take, total, totalPages: Math.ceil(total / take) },
    });
  } catch (error) {
    console.error('listContactAttempts error:', error);
    res.status(500).json({ error: 'Failed to fetch call log' });
  }
}

// GET /contact-attempts/officers — everyone who has logged a call, for the
// log's filter dropdown.
export async function getContactAttemptOfficers(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const officerIds = await prisma.contactAttempt.groupBy({
      by: ['officerId'],
      _count: { _all: true },
    });

    const officers = await prisma.adminUser.findMany({
      where: { id: { in: officerIds.map((row) => row.officerId) } },
      select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    const counts = new Map(officerIds.map((row) => [row.officerId, row._count._all]));

    res.json({
      officers: officers.map((o) => ({
        id: o.id,
        name: `${o.firstName} ${o.lastName}`.trim(),
        role: o.role.name,
        calls: counts.get(o.id) ?? 0,
      })),
    });
  } catch (error) {
    console.error('getContactAttemptOfficers error:', error);
    res.status(500).json({ error: 'Failed to fetch officers' });
  }
}

// GET /contact-attempts/customer/:customerId
export async function getCustomerContactHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { customerId } = req.params;

    const customer = await prisma.customer.findFirst({
      where: { OR: [{ id: customerId }, { id_uuid: customerId }] },
      select: { id_uuid: true, createdById: true },
    });

    if (!customer?.id_uuid) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const scope = await resolveCustomerScope(admin);
    if (!scopeAllows(scope, customer.createdById)) {
      res.status(403).json({ error: 'This customer belongs to an agent outside your assigned portfolio' });
      return;
    }

    const attempts = await prisma.contactAttempt.findMany({
      where: { customerId_uuid: customer.id_uuid },
      include: {
        contract: { select: { id: true, contractNumber: true } },
        officer: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { contactedAt: 'desc' },
    });

    res.json({ count: attempts.length, attempts });
  } catch (error) {
    console.error('getCustomerContactHistory error:', error);
    res.status(500).json({ error: 'Failed to fetch contact history' });
  }
}

import { Request, Response } from 'express';
import { createAuditLog } from '../services/auditService';
import {
  enrollManagedDeviceForContract,
  evaluateManagedDeviceForContract,
  getDeviceControlEnrollmentDefaults,
  getManagedDeviceByContract,
  getManagedDeviceHealthSummary,
  reconcileKnoxGuardWebhookEvent,
  listManagedDeviceCommands,
  listManagedDevices,
  processPendingManagedDeviceCommands,
  requestManagedDeviceLock,
  requestManagedDeviceUnlock,
} from '../services/deviceControlPolicyService';
import { AuthenticatedRequest } from '../middleware/auth';
import { validateKnoxWebhookRequest } from '../utils/knoxWebhookSecurity';

function getAdminUserId(req: AuthenticatedRequest): string | undefined {
  return req.userType === 'admin' ? req.user?.id : undefined;
}

export async function getKnoxGuardHealth(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const summary = await getManagedDeviceHealthSummary();
    res.json(summary);
  } catch (error) {
    console.error('Get Knox Guard health error:', error);
    res.status(500).json({ error: 'Failed to get Knox Guard health summary' });
  }
}

export async function listKnoxGuardDevices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const devices = await listManagedDevices();
    res.json({ devices });
  } catch (error) {
    console.error('List Knox Guard devices error:', error);
    res.status(500).json({ error: 'Failed to list managed devices' });
  }
}

export async function listKnoxGuardCommands(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const commands = await listManagedDeviceCommands(limit);
    res.json({ commands });
  } catch (error) {
    console.error('List Knox Guard commands error:', error);
    res.status(500).json({ error: 'Failed to list managed device commands' });
  }
}

export async function getKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const contract = await getManagedDeviceByContract(contractId);

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    res.json({
      contract,
      defaults: await getDeviceControlEnrollmentDefaults(),
    });
  } catch (error) {
    console.error('Get Knox Guard contract device error:', error);
    res.status(500).json({ error: 'Failed to get contract device details' });
  }
}

export async function enrollKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const { deviceUid, deviceUidType, approveId, knoxObjectId, knoxTenantDomain, metadata } = req.body;

    const result = await enrollManagedDeviceForContract(contractId, {
      deviceUid,
      deviceUidType,
      approveId,
      knoxObjectId,
      knoxTenantDomain,
      metadata,
      actor: {
        adminUserId: getAdminUserId(req),
      },
    });

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'ENROLL_KNOX_GUARD_DEVICE',
      entity: 'ManagedDevice',
      entityId: result.managedDeviceId,
      newValues: {
        contractId,
        approveId: result.approveId,
        deviceUid: result.deviceUid,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      message: 'Managed device enrolled and approval queued successfully',
      result,
    });
  } catch (error: any) {
    console.error('Enroll Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to enroll managed device' });
  }
}

export async function evaluateKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const result = await evaluateManagedDeviceForContract(contractId);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'EVALUATE_KNOX_GUARD_DEVICE',
      entity: 'ManagedDevice',
      entityId: contractId,
      newValues: result,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Managed device evaluated successfully',
      result,
    });
  } catch (error: any) {
    console.error('Evaluate Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to evaluate managed device' });
  }
}

export async function lockKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const { message } = req.body;
    const command = await requestManagedDeviceLock(contractId, message);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'LOCK_KNOX_GUARD_DEVICE',
      entity: 'ManagedDeviceCommand',
      entityId: command.id,
      newValues: {
        contractId,
        type: command.type,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Lock command queued successfully',
      command,
    });
  } catch (error: any) {
    console.error('Lock Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to queue lock command' });
  }
}

export async function unlockKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const { reason } = req.body;
    const command = await requestManagedDeviceUnlock(contractId, reason);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'UNLOCK_KNOX_GUARD_DEVICE',
      entity: 'ManagedDeviceCommand',
      entityId: command.id,
      newValues: {
        contractId,
        type: command.type,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Unlock command queued successfully',
      command,
    });
  } catch (error: any) {
    console.error('Unlock Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to queue unlock command' });
  }
}

export async function processKnoxGuardCommands(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.body.limit || '10'), 10) || 10, 1), 100);
    const result = await processPendingManagedDeviceCommands(limit);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'PROCESS_KNOX_GUARD_COMMANDS',
      entity: 'ManagedDeviceCommand',
      newValues: {
        limit,
        processed: result.processed,
        succeeded: result.succeeded,
        failed: result.failed,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Managed device commands processed successfully',
      result,
    });
  } catch (error: any) {
    console.error('Process Knox Guard commands error:', error);
    res.status(500).json({ error: error.message || 'Failed to process Knox Guard commands' });
  }
}

export async function handleKnoxGuardWebhook(req: Request, res: Response): Promise<void> {
  try {
    const validation = validateKnoxWebhookRequest(req);
    if (!validation.valid) {
      res.status(401).json({ error: validation.error || 'Invalid Knox webhook request' });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid Knox webhook payload' });
      return;
    }

    const event = typeof body.event === 'string' ? body.event.trim() : '';
    const payload = body.payload;

    if (!event || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({ error: 'Knox webhook event and payload are required' });
      return;
    }

    const result = await reconcileKnoxGuardWebhookEvent({
      subscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId.trim() : null,
      event,
      payload: payload as Record<string, unknown>,
      traceId: validation.traceId || null,
      validationMethod: validation.method,
      receivedAt: new Date().toISOString(),
    });

    await createAuditLog({
      action: 'RECONCILE_KNOX_GUARD_WEBHOOK',
      entity: 'ManagedDevice',
      entityId: result.managedDeviceId,
      newValues: {
        traceId: validation.traceId || null,
        validationMethod: validation.method || null,
        ...result,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (result.ignored) {
      res.status(202).json({
        received: true,
        ignored: true,
        result,
      });
      return;
    }

    res.json({
      received: true,
      duplicate: result.duplicate,
      result,
    });
  } catch (error: any) {
    console.error('Knox Guard webhook error:', error);
    res.status(500).json({ error: error.message || 'Failed to reconcile Knox webhook' });
  }
}

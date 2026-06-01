import { Request, Response } from 'express';
import { createAuditLog } from '../services/auditService';
import { lookupKnoxGuardDevice } from '../services/knoxGuardService';
import {
  checkKnoxPortalActiveDevices,
  enrollManagedDeviceForContract,
  enrollManagedDeviceManual,
  linkManagedDeviceToContract,
  evaluateManagedDeviceForContract,
  getDeviceControlEnrollmentDefaults,
  getManagedDeviceByContract,
  getManagedDeviceHealthSummary,
  reconcileKnoxGuardWebhookEvent,
  listManagedDeviceCommands,
  listManagedDevices,
  processPendingManagedDeviceCommands,
  requestManagedDeviceApprove,
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
    const page = Math.min(Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1), 100000);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 100);
    const q = String(req.query.q || '').trim();
    const enrollmentStatus = String(req.query.enrollmentStatus || '').trim() || undefined;
    const result = await listManagedDevices({ page, limit, q, enrollmentStatus });
    res.json(result);
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
      message: result.dryRun
        ? 'Managed device enrolled and approval simulated (dry-run mode)'
        : result.success
          ? 'Managed device enrolled and approved successfully'
          : 'Managed device enrolled; approval failed — retry via the approve endpoint',
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

export async function approveKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const result = await requestManagedDeviceApprove(contractId);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'APPROVE_KNOX_GUARD_DEVICE',
      entity: 'ManagedDevice',
      entityId: contractId,
      newValues: { contractId, success: result.success, dryRun: result.dryRun, transactionId: result.transactionId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (!result.success && !result.dryRun) {
      res.status(502).json({ error: result.error || 'Knox Guard approval failed' });
      return;
    }

    res.json({
      message: result.dryRun ? 'Approval simulated (dry-run mode)' : 'Device approved successfully',
      transactionId: result.transactionId,
      dryRun: result.dryRun,
    });
  } catch (error: any) {
    console.error('Approve Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to approve device' });
  }
}

export async function lockKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const { message } = req.body || {};
    const result = await requestManagedDeviceLock(contractId, message);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'LOCK_KNOX_GUARD_DEVICE',
      entity: 'ManagedDevice',
      entityId: contractId,
      newValues: {
        contractId,
        success: result.success,
        dryRun: result.dryRun,
        actualState: result.actualState,
        transactionId: result.transactionId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (!result.success && !result.dryRun) {
      res.status(502).json({ error: result.error || 'Knox Guard lock failed' });
      return;
    }

    res.json({
      message: result.dryRun ? 'Lock simulated (dry-run mode)' : 'Device locked successfully',
      actualState: result.actualState,
      transactionId: result.transactionId,
      dryRun: result.dryRun,
    });
  } catch (error: any) {
    console.error('Lock Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to lock device' });
  }
}

export async function unlockKnoxGuardContractDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;
    const { reason } = req.body || {};
    const result = await requestManagedDeviceUnlock(contractId, reason);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'UNLOCK_KNOX_GUARD_DEVICE',
      entity: 'ManagedDevice',
      entityId: contractId,
      newValues: {
        contractId,
        success: result.success,
        dryRun: result.dryRun,
        actualState: result.actualState,
        transactionId: result.transactionId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (!result.success && !result.dryRun) {
      res.status(502).json({ error: result.error || 'Knox Guard unlock failed' });
      return;
    }

    res.json({
      message: result.dryRun ? 'Unlock simulated (dry-run mode)' : 'Device unlocked successfully',
      actualState: result.actualState,
      transactionId: result.transactionId,
      dryRun: result.dryRun,
    });
  } catch (error: any) {
    console.error('Unlock Knox Guard device error:', error);
    res.status(400).json({ error: error.message || 'Failed to unlock device' });
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

// POST /api/knox-guard/devices/enroll-manual
// Body: { deviceUid, deviceUidType?, approveId?, note? }
export async function enrollDeviceManual(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { deviceUid, deviceUidType, approveId, note } = req.body as {
      deviceUid?: string;
      deviceUidType?: string;
      approveId?: string;
      note?: string;
    };

    if (!deviceUid) {
      res.status(400).json({ error: 'deviceUid is required' });
      return;
    }

    const result = await enrollManagedDeviceManual({ deviceUid, deviceUidType, approveId, note });

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'ENROLL_KNOX_GUARD_DEVICE_MANUAL',
      entity: 'ManagedDevice',
      entityId: result.managedDeviceId,
      newValues: { deviceUid, approveId: result.approveId, success: result.success, dryRun: result.dryRun },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      message: result.dryRun
        ? 'Manual enrollment simulated (dry-run)'
        : result.success
          ? 'Device enrolled manually and approved successfully'
          : 'Device enrolled manually; approval pending Knox Guard app connection',
      result,
    });
  } catch (error: any) {
    console.error('Manual Knox Guard enroll error:', error);
    res.status(400).json({ error: error.message || 'Failed to enroll device manually' });
  }
}

// PATCH /api/knox-guard/devices/:managedDeviceId/link-contract
// Body: { contractId }
export async function linkDeviceToContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { managedDeviceId } = req.params;
    const { contractId } = req.body as { contractId?: string };

    if (!contractId) {
      res.status(400).json({ error: 'contractId is required' });
      return;
    }

    const updated = await linkManagedDeviceToContract(managedDeviceId, contractId);

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'LINK_KNOX_DEVICE_TO_CONTRACT',
      entity: 'ManagedDevice',
      entityId: managedDeviceId,
      newValues: { contractId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Device linked to contract successfully', managedDevice: updated });
  } catch (error: any) {
    console.error('Link Knox device to contract error:', error);
    res.status(400).json({ error: error.message || 'Failed to link device to contract' });
  }
}

// GET /api/knox-guard/devices/portal-check
export async function checkPortalActiveDevices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const result = await checkKnoxPortalActiveDevices();
    res.json(result);
  } catch (error) {
    console.error('Knox portal active device check error:', error);
    res.status(500).json({ error: 'Failed to check Knox portal for active devices' });
  }
}

// GET /api/knox-guard/devices/portal-status/:serialNumber
// Looks up a device on the Knox portal by serial number / IMEI and returns its live status.
export async function getKnoxPortalDeviceStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { serialNumber } = req.params;
    if (!serialNumber) {
      res.status(400).json({ error: 'serialNumber is required' });
      return;
    }

    const result = await lookupKnoxGuardDevice({ deviceUid: serialNumber });

    if (!result.success) {
      res.status(result.statusCode ?? 502).json({
        found: false,
        error: result.error || 'Knox portal lookup failed',
      });
      return;
    }

    const deviceList = (result.data as any)?.deviceList;
    const device = Array.isArray(deviceList) ? deviceList[0] ?? null : null;

    res.json({
      found: Boolean(device),
      dryRun: result.dryRun ?? false,
      device: device
        ? {
            objectId: device.objectId ?? null,
            deviceUid: device.deviceUid ?? null,
            status: device.status ?? null,
            isOfflineLocked: device.isOfflineLocked ?? null,
            isOfflineLockApplied: device.isOfflineLockApplied ?? null,
            agentVersion: device.agentVersion ?? null,
            firmwareVersion: device.firmwareVersion ?? null,
            imeiNumber: device.imeiNumber ?? null,
          }
        : null,
    });
  } catch (error: any) {
    console.error('Knox portal status lookup error:', error);
    res.status(500).json({ error: 'Failed to look up device on Knox portal' });
  }
}

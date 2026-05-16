import crypto, { X509Certificate } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request } from 'express';
import { isWebhookTokenConfigured, validateWebhookRequest } from './callbackSecurity';

export interface KnoxWebhookSecuritySummary {
  signatureCertificateConfigured: boolean;
  sharedTokenConfigured: boolean;
  validationConfigured: boolean;
}

export interface KnoxWebhookValidationResult {
  valid: boolean;
  method?: 'samsung-signature' | 'shared-token';
  traceId?: string | null;
  error?: string;
}

const KNOX_GUARD_WEBHOOK_CERT_PATH = (process.env.KNOX_GUARD_WEBHOOK_CERT_PATH || '').trim();
const KNOX_GUARD_WEBHOOK_CERT_PEM = (process.env.KNOX_GUARD_WEBHOOK_CERT_PEM || '').trim();

let cachedCertificatePem: string | null | undefined;
let cachedPublicKey: crypto.KeyObject | null | undefined;

function normalizePemInput(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function resolveCertificatePem(): string | null {
  if (cachedCertificatePem !== undefined) {
    return cachedCertificatePem;
  }

  if (KNOX_GUARD_WEBHOOK_CERT_PEM) {
    cachedCertificatePem = normalizePemInput(KNOX_GUARD_WEBHOOK_CERT_PEM);
    return cachedCertificatePem;
  }

  if (!KNOX_GUARD_WEBHOOK_CERT_PATH) {
    cachedCertificatePem = null;
    return cachedCertificatePem;
  }

  try {
    const certificatePath = path.isAbsolute(KNOX_GUARD_WEBHOOK_CERT_PATH)
      ? KNOX_GUARD_WEBHOOK_CERT_PATH
      : path.resolve(process.cwd(), KNOX_GUARD_WEBHOOK_CERT_PATH);
    cachedCertificatePem = fs.readFileSync(certificatePath, 'utf8').trim();
    return cachedCertificatePem;
  } catch {
    cachedCertificatePem = null;
    return cachedCertificatePem;
  }
}

function getCertificatePublicKey(): crypto.KeyObject | null {
  if (cachedPublicKey !== undefined) {
    return cachedPublicKey;
  }

  const certificatePem = resolveCertificatePem();
  if (!certificatePem) {
    cachedPublicKey = null;
    return cachedPublicKey;
  }

  try {
    cachedPublicKey = new X509Certificate(certificatePem).publicKey;
    return cachedPublicKey;
  } catch {
    try {
      cachedPublicKey = crypto.createPublicKey(certificatePem);
      return cachedPublicKey;
    } catch {
      cachedPublicKey = null;
      return cachedPublicKey;
    }
  }
}

function getTraceId(req: Request): string | null {
  const traceId = req.header('x-wsm-traceid');
  return traceId ? traceId.trim() || null : null;
}

function getCandidatePayloadBuffers(req: Request): Buffer[] {
  const buffers: Buffer[] = [];

  if (req.rawBody?.length) {
    buffers.push(req.rawBody);
  }

  if (req.body !== undefined) {
    const serializedBody = Buffer.from(JSON.stringify(req.body));
    if (!buffers.some((buffer) => buffer.equals(serializedBody))) {
      buffers.push(serializedBody);
    }
  }

  return buffers;
}

function verifySamsungSignature(req: Request): KnoxWebhookValidationResult {
  const signatureHeader = req.header('x-wsm-signature');
  const traceId = getTraceId(req);

  if (!signatureHeader) {
    return {
      valid: false,
      traceId,
      error: 'Samsung webhook signature header is missing',
    };
  }

  const publicKey = getCertificatePublicKey();
  if (!publicKey) {
    return {
      valid: false,
      traceId,
      error: 'Samsung Knox webhook certificate is not configured or could not be loaded',
    };
  }

  const jwsParts = signatureHeader.split('.');
  if (jwsParts.length !== 3) {
    return {
      valid: false,
      traceId,
      error: 'Invalid Samsung webhook signature format',
    };
  }

  const [encodedHeaders, encodedPayload, encodedSignature] = jwsParts;
  const candidatePayloads = getCandidatePayloadBuffers(req);

  if (candidatePayloads.length === 0) {
    return {
      valid: false,
      traceId,
      error: 'Samsung webhook request body is unavailable for signature verification',
    };
  }

  for (const payloadBuffer of candidatePayloads) {
    const computedEncodedPayload = payloadBuffer.toString('base64url');
    if (encodedPayload && encodedPayload !== computedEncodedPayload) {
      continue;
    }

    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(`${encodedHeaders}.${computedEncodedPayload}`);
      verifier.end();

      const signatureBuffer = Buffer.from(encodedSignature, 'base64url');
      const verified = verifier.verify(publicKey, signatureBuffer);
      if (verified) {
        return {
          valid: true,
          method: 'samsung-signature',
          traceId,
        };
      }
    } catch {
      return {
        valid: false,
        traceId,
        error: 'Samsung webhook signature could not be verified',
      };
    }
  }

  return {
    valid: false,
    traceId,
    error: 'Samsung webhook signature validation failed',
  };
}

export function getKnoxWebhookSecuritySummary(): KnoxWebhookSecuritySummary {
  const signatureCertificateConfigured = Boolean(getCertificatePublicKey());
  const sharedTokenConfigured = isWebhookTokenConfigured();

  return {
    signatureCertificateConfigured,
    sharedTokenConfigured,
    validationConfigured: signatureCertificateConfigured || sharedTokenConfigured,
  };
}

export function validateKnoxWebhookRequest(req: Request): KnoxWebhookValidationResult {
  const signatureHeader = req.header('x-wsm-signature');
  const traceId = getTraceId(req);

  if (signatureHeader) {
    return verifySamsungSignature(req);
  }

  if (isWebhookTokenConfigured()) {
    const tokenError = validateWebhookRequest(req);
    if (!tokenError) {
      return {
        valid: true,
        method: 'shared-token',
        traceId,
      };
    }

    return {
      valid: false,
      traceId,
      error: tokenError,
    };
  }

  return {
    valid: false,
    traceId,
    error: 'Knox webhook validation is not configured. Set a Samsung webhook certificate or WEBHOOK_SHARED_TOKEN.',
  };
}

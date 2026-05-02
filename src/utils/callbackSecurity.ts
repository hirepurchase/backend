import crypto from 'crypto';
import { Request } from 'express';

const WEBHOOK_SHARED_TOKEN = process.env.WEBHOOK_SHARED_TOKEN?.trim() || '';

function getRequestToken(req: Request): string {
  const queryToken = typeof req.query.token === 'string'
    ? req.query.token
    : Array.isArray(req.query.token)
      ? typeof req.query.token[0] === 'string'
        ? req.query.token[0]
        : ''
      : '';

  const authHeader = req.header('authorization') || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  return (
    req.header('x-webhook-token') ||
    req.header('x-callback-token') ||
    bearerToken ||
    queryToken ||
    ''
  );
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function appendWebhookToken(callbackUrl: string): string {
  if (!WEBHOOK_SHARED_TOKEN || !callbackUrl) {
    return callbackUrl;
  }

  try {
    const parsedUrl = new URL(callbackUrl);
    parsedUrl.searchParams.set('token', WEBHOOK_SHARED_TOKEN);
    return parsedUrl.toString();
  } catch {
    const separator = callbackUrl.includes('?') ? '&' : '?';
    return `${callbackUrl}${separator}token=${encodeURIComponent(WEBHOOK_SHARED_TOKEN)}`;
  }
}

export function validateWebhookRequest(req: Request): string | null {
  if (!WEBHOOK_SHARED_TOKEN) {
    return null;
  }

  const requestToken = getRequestToken(req);

  if (!requestToken) {
    return 'Webhook token required';
  }

  if (!safeEquals(requestToken, WEBHOOK_SHARED_TOKEN)) {
    return 'Invalid webhook token';
  }

  return null;
}

export function isWebhookTokenConfigured(): boolean {
  return Boolean(WEBHOOK_SHARED_TOKEN);
}

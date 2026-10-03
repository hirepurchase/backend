import * as crypto from 'crypto';

/**
 * PayTrigger request signing (API doc §1.2).
 *
 *   1. take the top-level fields of the JSON body that have a value
 *   2. sort them by name (ASCII) and join as k1=v1&k2=v2
 *   3. HMAC-SHA256 with the apiKey, hex, upper-cased
 *   4. base64 of that hex string → the `sign` header
 *
 * Nested arrays/objects travel as JSON strings (imeiInfo, updateInfo, …) and
 * booleans are rendered as the literals true/false, so the signed text is the
 * same whatever language produced it. Callers must therefore pass a body whose
 * values are already strings, numbers or booleans — see `flatten`.
 */

export type SignableValue = string | number | boolean;
export type SignableBody = Record<string, SignableValue>;

/** Drop empty values and stringify anything nested, as the API expects. */
export function flatten(body: Record<string, unknown>): SignableBody {
  const out: SignableBody = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') out[key] = JSON.stringify(value);
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = String(value);
  }
  return out;
}

export function buildSignContent(body: SignableBody): string {
  return Object.keys(body)
    .filter((key) => body[key] !== undefined && body[key] !== null && body[key] !== '')
    .sort()
    .map((key) => `${key}=${body[key]}`)
    .join('&');
}

export function sign(body: SignableBody, apiKey: string): string {
  const hex = crypto.createHmac('sha256', apiKey).update(buildSignContent(body), 'utf8').digest('hex').toUpperCase();
  return Buffer.from(hex, 'utf8').toString('base64');
}

/**
 * Callbacks from PayTrigger carry the same `sign` header over their body.
 * Compared in constant time.
 */
export function verifyCallback(signHeader: string | undefined, body: Record<string, unknown>, apiKey: string): boolean {
  if (!signHeader || !apiKey) return false;
  const expected = sign(flatten(body), apiKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signHeader.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Knox Guard API connectivity test.
 * Run with: npx ts-node scripts/test-knox-api.ts
 *
 * Tests:
 *   1. Private key loads and is valid RSA
 *   2. Token generation (sign clientIdentifier → POST /accessToken → sign accessToken)
 *   3. Authorization check against Samsung Knox Guard API
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import * as path from 'path';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CLIENT_IDENTIFIER = (process.env.KNOX_GUARD_CLIENT_IDENTIFIER || '').trim();
const PRIVATE_KEY_PATH = (process.env.KNOX_GUARD_PRIVATE_KEY_PATH || '').trim();
const BASE_URL = (process.env.KNOX_GUARD_BASE_URL || '').trim();
const CHECK_AUTH_PATH = (process.env.KNOX_GUARD_CHECK_AUTH_PATH || '/authorization').trim();
const ACCESS_TOKEN_VALIDITY_MINUTES = Number(process.env.KNOX_GUARD_ACCESS_TOKEN_VALIDITY_MINUTES || '30');
const KNOX_GUARD_JWT_AUDIENCE = 'KnoxWSM';
const KNOX_HTTPS_AGENT = new https.Agent({ family: 4 });

function getTokenEndpoint(): string {
  if (BASE_URL) {
    return new URL('/ams/v1/users/accesstoken', BASE_URL).toString();
  }
  return 'https://us-kcs-api.samsungknox.com/ams/v1/users/accesstoken';
}

function step(label: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
}

function ok(msg: string) { console.log(`  ✓  ${msg}`); }
function fail(msg: string) { console.error(`  ✗  ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }

function loadPrivateKeyPem(): string {
  const raw = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8').trim();
  if (raw.startsWith('-----BEGIN')) return raw;
  return `-----BEGIN PRIVATE KEY-----\n${raw.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

function getBase64EncodedStringPublicKey(privateKeyPem: string): string {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
}

function generateKnoxJwtId(): string {
  return `${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
}

function signPayload(payload: Record<string, unknown>, privateKeyPem: string): string {
  return jwt.sign(
    { ...payload, publicKey: getBase64EncodedStringPublicKey(privateKeyPem) },
    privateKeyPem,
    {
      algorithm: 'RS512',
      audience: KNOX_GUARD_JWT_AUDIENCE,
      expiresIn: '30m',
      jwtid: generateKnoxJwtId(),
    }
  );
}

async function run() {
  console.log('\n  Knox Guard API Test');
  console.log('  ' + new Date().toISOString());

  // ── Step 1: Validate config ───────────────────────────────────────────────
  step('1 / 4  Validate configuration');
  let hasError = false;

  if (!CLIENT_IDENTIFIER) { fail('KNOX_GUARD_CLIENT_IDENTIFIER is not set'); hasError = true; }
  else ok(`CLIENT_IDENTIFIER loaded (${CLIENT_IDENTIFIER.slice(0, 40)}…)`);

  if (!PRIVATE_KEY_PATH) { fail('KNOX_GUARD_PRIVATE_KEY_PATH is not set'); hasError = true; }
  else if (!fs.existsSync(path.resolve(__dirname, '..', PRIVATE_KEY_PATH))) {
    fail(`Private key file not found: ${PRIVATE_KEY_PATH}`); hasError = true;
  } else ok(`Private key file found: ${PRIVATE_KEY_PATH}`);

  if (!BASE_URL) { fail('KNOX_GUARD_BASE_URL is not set'); hasError = true; }
  else ok(`Base URL: ${BASE_URL}`);

  if (hasError) { process.exit(1); }

  // ── Step 2: Validate private key ─────────────────────────────────────────
  step('2 / 4  Load and validate private key');
  let privateKeyPem: string;
  try {
    privateKeyPem = loadPrivateKeyPem();
    const keyObj = crypto.createPrivateKey(privateKeyPem);
    ok(`Key type: ${keyObj.asymmetricKeyType?.toUpperCase()}`);
    const keySize = (keyObj.asymmetricKeyDetails as any)?.modulusLength;
    if (keySize) ok(`Key size: ${keySize} bits`);
  } catch (err: any) {
    fail(`Failed to load private key: ${err.message}`);
    process.exit(1);
  }

  // ── Step 3: Generate API token ────────────────────────────────────────────
  step('3 / 4  Generate Knox API token');
  let apiToken: string;
  try {
    // Step 3a — sign client identifier
    info('Signing client identifier JWT with private key…');
    const clientIdentifierJwt = signPayload({ clientIdentifier: CLIENT_IDENTIFIER }, privateKeyPem!);
    const base64EncodedStringPublicKey = getBase64EncodedStringPublicKey(privateKeyPem!);
    const tokenEndpoint = getTokenEndpoint();
    ok(`clientIdentifierJwt created (${clientIdentifierJwt.slice(0, 50)}…)`);

    // Step 3b — exchange for access token
    info(`POST ${tokenEndpoint}`);
    const tokenRes = await axios.post(
      tokenEndpoint,
      {
        clientIdentifierJwt,
        base64EncodedStringPublicKey,
        validityForAccessTokenInMinutes: ACCESS_TOKEN_VALIDITY_MINUTES,
      },
      {
        timeout: 30000,
        httpsAgent: KNOX_HTTPS_AGENT,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      } as any
    );
    const rawAccessToken: string = (tokenRes.data as Record<string, unknown>)?.accessToken as string;
    if (!rawAccessToken) {
      fail(`Unexpected response — no accessToken field. Response: ${JSON.stringify(tokenRes.data)}`);
      process.exit(1);
    }
    ok(`Access token received (status ${tokenRes.status})`);
    info(`accessToken: ${rawAccessToken.slice(0, 50)}…`);

    // Step 3c — sign the access token
    info('Signing access token with private key…');
    apiToken = signPayload({ accessToken: rawAccessToken }, privateKeyPem!);
    ok(`x-knox-apitoken ready (${apiToken.slice(0, 50)}…)`);
  } catch (err: any) {
    const status = err.response?.status;
    const data = err.response?.data;
    const headers = err.response?.headers;
    fail(`Token generation failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    if (data) info(`Response body: ${JSON.stringify(data)}`);
    if (headers) info(`Response headers: ${JSON.stringify(headers)}`);
    if (!status) info(`Full error: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
    process.exit(1);
  }

  // ── Step 4: Check authorization ───────────────────────────────────────────
  step('4 / 4  Check Knox Guard authorization');
  const authUrl = `${BASE_URL}${CHECK_AUTH_PATH}`;
  info(`GET ${authUrl}`);
  try {
    const authRes = await axios.get(authUrl, {
      timeout: 30000,
      httpsAgent: KNOX_HTTPS_AGENT,
      headers: {
        Accept: 'application/json',
        'x-knox-apitoken': apiToken!,
      },
    } as any);
    ok(`Authorization check passed (HTTP ${authRes.status})`);
    info(`Response: ${JSON.stringify(authRes.data)}`);
  } catch (err: any) {
    const status = err.response?.status;
    const data = err.response?.data;
    fail(`Authorization check failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    if (data) info(`Response body: ${JSON.stringify(data)}`);
    if (status === 401) info('→ Token was rejected. Check that your active public key is registered on the Knox portal.');
    if (status === 403) info('→ Authenticated but not authorised. Check Knox Guard tenant permissions.');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  All tests passed — Knox Guard API is reachable and authenticated.');
  console.log('═'.repeat(60) + '\n');
}

run().catch((err) => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});

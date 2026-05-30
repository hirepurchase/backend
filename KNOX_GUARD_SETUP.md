# Knox Guard Setup Notes

This backend now contains a first working Knox Guard integration foundation.

## What Exists

- managed-device schema in `prisma/schema.prisma`
- command queue and processor
- policy evaluation after overdue changes and successful payments
- admin API routes under `/api/knox-guard`
- automatic command processing scheduler

## Current Safe Default

Knox Guard actions run in `dry-run` mode unless you explicitly set:

- `KNOX_GUARD_DRY_RUN=false`
- `KNOX_GUARD_ENABLE_LIVE_ACTIONS=true`

This prevents accidental live lock or unlock requests while you are still validating Samsung tenant details.

## Required Environment Variables

See `.env.production.example` for the full list.

At minimum you’ll need:

- `KNOX_GUARD_BASE_URL` — regional Samsung URL, e.g. `https://us-kcs-api.samsungknox.com/kcs/v1.1/kg`
- `KNOX_GUARD_CHECK_AUTH_PATH` — must be `/authorization`
- `KNOX_GUARD_LIST_DEVICES_PATH` — must be `/devices/list`
- `KNOX_GUARD_APPROVE_DEVICE_PATH`
- `KNOX_GUARD_LOCK_DEVICE_PATH`
- `KNOX_GUARD_UNLOCK_DEVICE_PATH`

For authentication, configure one of these modes:

- Static token mode:
  - `KNOX_GUARD_API_TOKEN` — static token from Knox API Portal (expires every 30 min; regenerate before use)
- Knox Cloud Authentication mode:
  - `KNOX_GUARD_CLIENT_IDENTIFIER`
  - either `KNOX_GUARD_PRIVATE_KEY` or `KNOX_GUARD_PRIVATE_KEY_PATH`

The backend supports inline PEM keys through `KNOX_GUARD_PRIVATE_KEY`, which is useful in cloud deployments where mounting a key file is inconvenient.

Policy and customer-experience settings (support phone, lock threshold, messages, disclosure text, lock-screen toggles, scheduler config) are now stored in the database and managed via the admin **Knox Guard Settings** page at `/admin/settings/knox-guard`. They no longer require env vars.

For Samsung webhook verification and reconciliation, configure at least one of:

- `KNOX_GUARD_WEBHOOK_CERT_PATH`
- `KNOX_GUARD_WEBHOOK_CERT_PEM`

For manual/local webhook testing, you can also reuse `WEBHOOK_SHARED_TOKEN`.

## First Live-Test Checklist

1. Keep `KNOX_GUARD_DRY_RUN=true`
2. Enroll a single non-production test contract device
3. Verify the device record, queued command, and policy evaluation from the admin page
4. Confirm the real Samsung request paths and payloads against your tenant
5. Set `KNOX_GUARD_DRY_RUN=false` only after the above is confirmed
6. Enable live actions only for a test environment first

## Admin Routes

- `GET /api/knox-guard/health`
- `GET /api/knox-guard/settings`
- `PATCH /api/knox-guard/settings`
- `GET /api/knox-guard/devices`
- `GET /api/knox-guard/commands`
- `GET /api/knox-guard/contracts/:contractId`
- `POST /api/knox-guard/contracts/:contractId/enroll`
- `POST /api/knox-guard/contracts/:contractId/evaluate`
- `POST /api/knox-guard/contracts/:contractId/lock`
- `POST /api/knox-guard/contracts/:contractId/unlock`
- `POST /api/knox-guard/commands/process`
- `POST /api/knox-guard/webhook`

## Next Recommended Steps

1. Replace the placeholder Knox Guard endpoint paths with the exact paths and payload contract from your tenant
2. Subscribe your Knox Guard tenant events to `POST /api/knox-guard/webhook`
3. Download and configure the Samsung webhook validation certificate
4. Add warning-notification automation before restriction
5. Add advanced policies such as blinking reminders, app blocklist, and overdue wallpaper

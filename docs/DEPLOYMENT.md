# Deployment and Operations Runbook

## 1. Topology

```
Browser ──HTTPS──> Reverse proxy / App Gateway (TLS, HSTS, WAF)
                      │  (WebSocket upgrade must be allowed for /socket.io)
                      ▼
                Node API container(s)  ── serves /api, /socket.io and the built SPA
                      │
                      ├── MongoDB replica set (Atlas / Cosmos DB for MongoDB vCore / self-managed, 3 members)
                      ├── Microsoft Graph (sendMail)         [outbound HTTPS]
                      └── Microsoft Entra ID (OIDC SSO)       [outbound HTTPS, required]
```

- One container image (see `Dockerfile`) serves both the API and the static web app from the same origin, so the cookies stay first-party and `SameSite=Lax` works.
- **Running more than one API instance**:
  - The email outbox worker is multi-instance safe, because messages are claimed atomically with a lease.
  - The monitors are idempotent (dedupe keys), so running them on every instance is safe but wasteful. Set `WORKERS_ENABLED=false` on all instances except one, or run a dedicated worker instance.
  - Socket.IO needs sticky sessions, or the `@socket.io/redis-adapter`, so events reach users connected to another instance.
  - Rate limiting uses an in-memory store. Switch to a shared store (Redis) for accurate limits across instances.

## 2. Configuration and secrets

All configuration is through environment variables (`server/.env.example` documents each one). In production, inject them from a secrets manager such as Azure Key Vault, AWS Secrets Manager or Kubernetes Secrets. Never bake them into the image.

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | Enables production safety checks. Startup **fails** if dev secrets, `EMAIL_MODE=mock`, `MONGODB_URI=memory` or `COOKIE_SECURE=false` are detected. |
| `APP_BASE_URL` | Public HTTPS URL. Used in email links. |
| `MONGODB_URI` | Replica-set URI with TLS and a least-privilege user (readWrite on the app database only). |
| `PIN_HMAC_KEY`, `TOKEN_HMAC_KEY` | 32+ random bytes each. Rotating `PIN_HMAC_KEY` invalidates outstanding PINs (coordinators can regenerate them). Rotating `TOKEN_HMAC_KEY` signs everyone out and invalidates pending Microsoft self-registrations. |
| `DATA_ENCRYPTION_KEY` | Base64 of exactly 32 bytes (AES-256-GCM). Encrypts the employee-viewable PIN copy and queued email secrets. Rotation: drain the outbox and let active PINs expire, or regenerate them, before switching. |
| `COOKIE_SECURE=true`, `TRUST_PROXY=<hops>` | Required behind TLS-terminating proxies so client IPs and secure cookies work. |
| `EMAIL_MODE=graph` + `GRAPH_*` | See the production checklist. |
| `ENTRA_*` | Microsoft sign-in. All four values are required, and production refuses to start without them because employees sign in only with Microsoft. **Secret expiry:** Azure client secrets expire, usually after 6, 12 or 24 months. Check the "Expires" date under **Certificates & secrets** in the Azure app and set a reminder. When it expires, every employee's Microsoft sign-in stops working until you add a new secret. |
| `ALLOWED_EMAIL_DOMAINS` | Restricts employee and coordinator emails to company domains. |
| `METRICS_TOKEN` | Bearer token for `GET /api/metrics` (Prometheus text). When blank the endpoint returns 404. |
| `WORKERS_ENABLED` | Outbox sender and operational monitors (see §1). |

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 3. Build, migrate, deploy

```bash
docker build -t cab-booking:<version> .
# Migration step (idempotent): creates collections, indexes, default policy
docker run --rm --env-file prod.env cab-booking:<version> node server/dist/scripts/migrate.js
# Deploy (rolling update), then verify:
curl -f https://<host>/api/health          # liveness
curl -f https://<host>/api/health/ready    # readiness (DB ping)
```

- **Schema changes**: MongoDB is schema-less, so changes are additive and backward-compatible across one release. New fields get defaults, and the old code ignores unknown fields. `syncIndexes()` runs on startup and in the migrate step.
  - **Index changes that drop an index will take effect on the first new instance**. Review index diffs before deploying.
  - For data back-fills, add a script under `server/src/scripts/` and run it like `migrate`.
- **First admin account**: there is no self-registration for admins. Run the bootstrap command once against production:

  ```bash
  docker run --rm --env-file prod.env cab-booking:<version> node server/dist/scripts/create-admin.js --email it.admin@company.com --name "IT Admin"
  ```

  It creates an `INVITED` admin who becomes active on their first "Sign in with Microsoft" with that email; no email is sent. Running it again for the same invited admin changes nothing. It refuses to touch any existing non-admin or active account. Don't use the seed script in production; it refuses to run there.

## 4. Rollback

1. Re-deploy the previous image tag. Because changes are additive, the previous version reads the newer documents.
2. If a release added a unique index that the previous version violates, drop that index (`db.<collection>.dropIndex('<name>')`) before rolling back.
3. Emails already queued in the outbox are sent by whichever version is running. Templates are rendered at send time.

## 5. Backups and recovery

- Enable continuous backup with point-in-time restore (Atlas/Cosmos), or run `mongodump --oplog` at least daily with 30-day retention, encrypted at rest and stored in another region.
- **Test the restore quarterly**: restore into a staging cluster, point a staging app at it, and run the smoke test from §7.
- **RPO/RTO targets** (suggested): RPO ≤ 15 min with PITR, RTO ≤ 2 h.
- After a restore, the outbox may contain messages that were already sent before the restore point. Review `PENDING` and `RETRYING` messages in **Email delivery** before re-enabling workers.

## 6. Monitoring and alerting

- **Logs**: structured JSON (pino) on stdout. PINs, passwords, tokens, cookies and auth headers are redacted, and query strings are not logged. Ship the logs to your log platform.
- **Metrics**: `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` exposes HTTP response counts, emails accepted/retried/failed, and outbox gauges by status.
- **Alert on**:
  - readiness failures
  - 5xx rate
  - `cab_email_outbox_failed` > 0
  - `cab_email_outbox_retrying` growing for more than 15 min (Graph outage)
- **In-app**: the admin dashboard shows failed emails; coordinators get bell notifications for late pickups, unconfirmed or declined rides, PIN lockouts and expiring documents; and *Email delivery* lists failures with a retry button.

## 7. Post-deploy smoke test

1. `GET /api/health/ready` returns 200.
2. Sign in as a coordinator and open today's cab requests.
3. On staging: create a booking as a test employee, assign it, and confirm the assignment email shows `Sent (accepted)` in *Email delivery*. Then run the driver flow through to completion using the PIN from the employee's booking page.

## 8. Incident playbooks

| Incident | Action |
|---|---|
| **Microsoft Graph outage / throttling** | Nothing is lost. Emails go to `RETRYING` with backoff (honouring `Retry-After`). Bookings and assignments keep working. When retries run out, messages become `FAILED`; once Graph recovers, retry them from *Email delivery*. |
| **Graph credential expired** (401/403 → `FAILED`) | Rotate `GRAPH_CLIENT_SECRET` in the secrets manager, restart, then retry the failed messages. |
| **Employees can't sign in with Microsoft** (sign-in page shows "Microsoft sign-in failed") | Usually an expired `ENTRA_CLIENT_SECRET`. In the Azure app, open **Certificates & secrets**, add a new client secret, copy its **Value** into `ENTRA_CLIENT_SECRET` in the secrets manager, restart, then delete the old secret and set a reminder for the new expiry date. Admins, coordinators and drivers can still sign in with passwords meanwhile. |
| **Driver unreachable / offline** | The assignment persists. After the acknowledgement timeout, coordinators get a notification and reassign from the booking page. |
| **PIN locked / employee can't access PIN** | The coordinator uses *Regenerate PIN*. As a last resort, *Support override start* requires a reason and is audited as `SUPPORT_OVERRIDE_START`. |
| **Suspected account compromise** | Suspend the user (this revokes all sessions immediately), then review the audit log filtered by that user's email. |
| **Database failover** | The driver retries automatically. Transactions are retried on transient errors. Verify readiness. |
| **Data leak suspected** | Rotate `TOKEN_HMAC_KEY` (forces sign-out), `PIN_HMAC_KEY` and `DATA_ENCRYPTION_KEY` (see §2), and rotate the Graph and Entra secrets. |

## 9. Data retention and privacy

- Employee records with booking history are deactivated, never deleted.
- Expired sessions and auth tokens are removed automatically by TTL indexes.
- Decide and configure retention for the audit log, trip history and email outbox, for example 2 years for trips and 1 year for the outbox. A scheduled job or a TTL index on `createdAt` can enforce it.
- No GPS or location data is collected in this release. If live tracking is added later, collect it only during authorised trips, restrict access, and set a short retention period.

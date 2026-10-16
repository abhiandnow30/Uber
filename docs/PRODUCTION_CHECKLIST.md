# Production Readiness Checklist

This application is **not production-ready until every item below has been completed and verified in your environment**. The automated tests cover application behaviour. They can't confirm your tenant configuration, infrastructure, or organisational approvals.

## A. External credentials and administrator approvals

### Microsoft Graph: Outlook email (required)

| Step | Owner | Done |
|---|---|---|
| Create a shared mailbox for sending, e.g. `transport@company.com` (`GRAPH_SENDER_MAILBOX`). | Exchange admin | ☐ |
| Register an app in **Microsoft Entra ID** for the backend (`GRAPH_CLIENT_ID`, tenant id → `GRAPH_TENANT_ID`). | Entra admin | ☐ |
| Add the Microsoft Graph **application** permission `Mail.Send` and grant **admin consent**. | Global/Privileged Role admin | ☐ |
| **Restrict the app to the sender mailbox only** with an Exchange Online *Application Access Policy* (`New-ApplicationAccessPolicy -AccessRight RestrictAccess -AppId <id> -PolicyScopeGroupId <mail-enabled security group containing the mailbox>`), or RBAC for Applications. Without this, `Mail.Send` can send as **any** mailbox. | Exchange admin | ☐ |
| Create a client secret (or, preferably, a certificate), store it in the secrets manager (`GRAPH_CLIENT_SECRET`), and record its expiry date in your rotation calendar. | Entra admin / Ops | ☐ |
| Confirm SPF, DKIM and DMARC for the sending domain. | Mail admin | ☐ |
| Send a test email from staging and confirm it lands in the inbox, not junk. | Ops | ☐ |

### Microsoft Entra ID sign-in (required: employees sign in only with Microsoft)

| Step | Owner | Done |
|---|---|---|
| Register a web app (can be separate from the Graph app): redirect URI `https://<host>/api/auth/sso/callback`, ID tokens, scopes `openid profile email`. | Entra admin | ☐ |
| Set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` (the secret's **Value**, not its Secret ID) and `ENTRA_REDIRECT_URI`. | Ops | ☐ |
| **Secret expiry:** Azure client secrets expire, usually after 6, 12 or 24 months. Check the "Expires" date under **Certificates & secrets** in the Azure app and set a reminder. When it expires, every employee's Microsoft sign-in stops working until you add a new secret. | Entra admin / Ops | ☐ |
| Optional: assign the enterprise app to a group so only intended staff can sign in. Anyone who can sign in to the app with an `ALLOWED_EMAIL_DOMAINS` address and isn't registered yet can register themselves. | Entra admin | ☐ |

### Other

| Item | Owner | Done |
|---|---|---|
| Production MongoDB replica set (3 members, TLS, least-privilege user, backups with PITR). | DBA / Cloud | ☐ |
| TLS certificate and domain; WebSocket upgrades allowed on `/socket.io`. | Network | ☐ |
| HR approval of the employee data fields stored, plus the retention policy (see DEPLOYMENT §9). | HR / Privacy | ☐ |
| Agreed office list, time zones, shifts and booking rules entered under *Booking policy*. | Transport team | ☐ |
| Microsoft Entra app registration for sign-in (`ENTRA_*`), and `ALLOWED_EMAIL_DOMAINS` set to the company domains: anyone in the tenant with one of those domains can self-register. | IT | ☐ |

## B. Configuration

- ☐ `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY` set correctly.
- ☐ Unique random `PIN_HMAC_KEY`, `TOKEN_HMAC_KEY` and `DATA_ENCRYPTION_KEY` loaded from the secrets manager. The server refuses dev values.
- ☐ `EMAIL_MODE=graph`. The server refuses `mock` in production.
- ☐ `ALLOWED_EMAIL_DOMAINS` set to company domains.
- ☐ `METRICS_TOKEN` set and the scraper configured.
- ☐ `WORKERS_ENABLED=true` on exactly one instance (or a dedicated worker).
- ☐ Multi-instance only: Socket.IO Redis adapter or sticky sessions, plus a shared rate-limit store.

## C. Verification before go-live

- ☐ `npm test` passes in CI (server suites, including the full end-to-end workflow).
- ☐ `npm run typecheck` and `npm run build` pass.
- ☐ `npm run test:ui` (browser smoke test of the core workflow) passes against staging with seed-like test accounts. It covers the happy path plus a wrong PIN; broader browser coverage (self-registration, reassignment, admin edits) is still recommended.
- ☐ Security review / penetration test of staging (auth, IDOR, CSRF, rate limits, file upload).
- ☐ `npm audit --omit=dev` reviewed. At the time of writing, 2 moderate advisories remain for `react-router-dom` 6 (open redirect via crafted paths, fixed only in v7). The app never navigates to untrusted paths and the post-login redirect is restricted to same-app paths; plan the v7 upgrade. Dependency update policy agreed.
- ☐ Backup restore tested (DEPLOYMENT §5).
- ☐ Load test of the morning booking and assignment peak.
- ☐ Alerts wired (DEPLOYMENT §6) and on-call runbook reviewed (DEPLOYMENT §8).
- ☐ First admin created with `create-admin` (DEPLOYMENT §3), test data removed, policy configured.
- ☐ Accessibility check of the employee and driver flows on real phones.

## D. Known limitations in this release

- No live GPS tracking, maps, ETA or automatic assignment. The data model and services are designed so these can be added. Coordinates are never simulated.
- `DELIVERED` email status requires a delivery-evidence integration (e.g. Exchange message trace), which is not implemented. Emails show `ACCEPTED` once Graph accepts them.
- Mobile push notifications are not implemented. Drivers get in-app notifications, real-time over WebSocket and persisted for when they reconnect.
- Round trips are supported by the API and data model (two linked legs) but are disabled by default in policy.

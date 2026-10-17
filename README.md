# Employee Cab Booking & Fleet Management

A web application for corporate employee transport. Employees request cabs, coordinators assign drivers and vehicles, and drivers run trips from a mobile-first dashboard using a ride-start PIN. Administrators manage onboarding, policies, reports and the audit trail.

| Role | What they do |
|---|---|
| **Admin** | Employee onboarding (manual or Microsoft self-registration), coordinators, other admins (add, suspend, deactivate, reactivate; never yourself or the last active admin), driver document verification, booking policy, reports, email-delivery monitoring, audit log. Admins can also use every coordinator screen across all offices. |
| **Coordinator** | Signs in with the email and mobile number an admin registered. Drivers, vehicles and driver↔vehicle links, the daily request queue, assignment/reassignment/cancellation, in-app alerts about rides that need attention, and audited support actions for stuck trips (start without PIN, complete on the driver's behalf, record a no-show). Limited to the offices an admin assigns and, optionally, to specific shifts. |
| **Employee** | Requests cabs, sees assignment details and the ride-start PIN, cancels within policy, receives Outlook emails and in-app notifications. |
| **Driver** | Signs in on their phone with the mobile number the coordinator registered and the last 4 characters of their linked vehicle's number (no email or password). Sees assigned rides, acknowledges or declines them, marks en route and arrived, enters the employee's PIN to start, completes the trip. |

## Stack

- **server/**: Node 22, Express 5, TypeScript, Mongoose 8 (MongoDB **replica set**, needed for transactions), Socket.IO, zod, pino, `@azure/msal-node` (optional SSO), Microsoft Graph via REST.
- **client/**: React 18, TypeScript, Vite, Tailwind CSS, React Router, TanStack Query, socket.io-client.
- **Tests**: Vitest and Supertest against an in-memory MongoDB replica set (`mongodb-memory-server`), plus a Puppeteer browser smoke test driving the real UI.

## Quick start (local development)

You need Node 20.11 or later. You do **not** need MongoDB or Docker to run it locally.

```bash
npm install
cp server/.env.example server/.env     # dev defaults work as-is (EMAIL_MODE=mock)
npm run seed:memdb                     # dev data + test accounts (run while the dev server is stopped)
npm run dev:memdb                      # API on :4000 + web on http://localhost:5173
```

- `npm run dev:memdb` starts a local single-node MongoDB replica set and persists it under `server/.data/`.
- To use your own MongoDB, set `MONGODB_URI` (it must be a replica set), then run `npm run seed` and `npm run dev`. `docker compose up mongo` gives you one.

### Development test accounts (seed only)

All seed accounts use the password `Password123!`. The seed script refuses to run when `NODE_ENV=production`.

| Role | Email |
|---|---|
| Admin | admin@example.com |
| Coordinator (HYD, BLR) | *Coordinator sign-in*: coordinator@example.com + mobile 9000000001 |
| Employee (EMP1001, HYD) | employee@example.com |
| Driver (DRV001, vehicle TS09AB1234) | *Driver sign-in*: mobile 9000020001, vehicle 1234 |
| Driver (DRV002, vehicle TS09CD5678) | *Driver sign-in*: mobile 9000020002, vehicle 5678 |

### Emails in development

With `EMAIL_MODE=mock` nothing is sent. Each email is written as an HTML file to `server/.dev-mailbox/`, so you can open activation and password-reset links locally. Mock mode is a clearly marked development stand-in, and the server refuses to start with it in production.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run dev:memdb` | API + web with hot reload |
| `npm test` | Server unit, integration and API end-to-end tests |
| `npm run test:ui` | Browser smoke test of the full employee → coordinator → driver workflow through the real UI (needs the app running with seed data and a local Chrome/Edge; see `server/e2e/ui-smoke.mjs`) |
| `npm run typecheck` | Type-check server and client |
| `npm run build` | Build server (`server/dist`) and client (`client/dist`) |
| `npm start` | Run the built server; it also serves `client/dist` |
| `npm run migrate -w server` | Create collections, indexes and the default policy (idempotent) |
| `npm run seed` | Development seed data |
| `npm run create-admin -w server -- --email <email> --name "<name>"` | Create the first administrator (works in production; sends an activation invitation, never sets a password) |

## How the key workflows are protected

- **Authorization** is enforced on the server for every route: a role gate plus resource-level checks. Employees only ever query by their own user id, drivers by their own driver profile, and coordinators by their assigned offices. Hiding things in the UI is never relied on. Requests for a record you don't own return 404, so the API doesn't reveal that it exists.
- **Sessions** are random tokens in an `httpOnly` `SameSite=Lax` cookie. Only an HMAC of the token is stored, which makes sessions revocable. They have absolute and idle expiry and are revoked on logout, password reset, suspension and deactivation. CSRF protection uses a required `X-Requested-With` header plus a session-bound token echoed in `X-CSRF-Token`.
- **Passwords** are hashed with scrypt. Five failed sign-ins lock the account for 15 minutes. Activation and reset tokens are single-use, stored hashed, expire, and are consumed atomically.
- **Login messages**: unknown accounts and wrong passwords get the same message, to prevent account enumeration. Colleagues who sign in with Microsoft but aren't registered get the self-registration form; if they can't register (email outside `ALLOWED_EMAIL_DOMAINS` or already used), they're asked to contact an administrator, who adds them under *Employees*.
- **Double-booking**: assignments run in a MongoDB transaction that first bumps a lock counter on the driver and vehicle documents. Concurrent transactions for the same driver or vehicle hit a write conflict and are retried; the retry then sees the committed overlap and fails with `SCHEDULE_CONFLICT`. Partial unique indexes back this up: one active assignment per booking, one open booking per employee per pickup time, and one current link per driver and per vehicle. A retried *Assign* click with the same `Idempotency-Key` returns the original assignment.
- **Ride-start PIN**: 4 digits from `crypto.randomInt`. For verification the server stores `HMAC-SHA256(PIN_HMAC_KEY, salt:pin)`, a keyed hash, so a database leak alone does not reveal it. A separate AES-256-GCM copy lets **only the assigned employee** view the PIN again in their authenticated booking page. Plaintext is never stored, logged, emailed or sent to drivers. Each attempt is reserved atomically before comparison, so parallel guessing can't exceed the limit (5 by default, then locked). The PIN expires, and the trip start is one transaction of conditional updates, so duplicate submissions start a trip exactly once. Reassignment, cancellation, completion and override all revoke the PIN.
- **State machines** for accounts and bookings live in `server/src/domain.ts`. Every status change is a conditional update against the expected previous state, and each one writes to the trip status history. Clients can't set a status directly.
- **Notifications** use a transactional outbox. The email job is written in the same transaction as the business change. A worker sends it with a lease, exponential backoff and an idempotency key, and records every attempt. A message is marked `ACCEPTED` when Microsoft Graph returns 202. That is **not** treated as delivery; `DELIVERED` is reserved for real delivery evidence, which isn't integrated yet. Email failures can never roll back or duplicate an assignment. In-app notifications are persisted, pushed over Socket.IO, and re-synced from the API when a client reconnects.
- **Microsoft self-registration**: a colleague who signs in with Microsoft but isn't registered yet gets a signed, 30-minute registration ticket (httpOnly cookie, HMAC with `TOKEN_HMAC_KEY`) and completes a form with employee ID, name, phone, office, route and home address. The email always comes from the verified Microsoft identity, never the form. The account is created **active** and bound to the Microsoft object id in one transaction. Emails outside `ALLOWED_EMAIL_DOMAINS`, or already used by another account, are refused.
- **Coordinator sign-in**: coordinators are often outside the company, so they sign in with the email and mobile number an admin registered (no password, invitation or Microsoft account). Neither is secret, so the same safeguards as driver sign-in apply: identical messages for every mismatch, a 15-minute lock after 5 wrong tries, and deleting or deactivating the coordinator stops sign-in at once.
- **Driver sign-in** uses the mobile number the coordinator registered plus the last 4 characters of the vehicle currently linked to the driver. Neither is secret, so the risk is accepted deliberately: mismatches all get the same message, 5 wrong tries lock that number for 15 minutes, a number can belong to only one active driver, and unlinking the vehicle or deactivating the driver stops sign-in at once. Drivers have no password, invitation or reset email.
- **Microsoft client secret expiry**: Azure client secrets expire, usually after 6, 12 or 24 months. Check the "Expires" date under **Certificates & secrets** in the Azure app and set a reminder. When it expires, every employee's Microsoft sign-in stops working until you add a new secret.
- **Deactivating** an employee or driver with live or upcoming rides flags those rides and notifies the office's coordinators for a human decision. Rides are never deleted or interrupted silently.
- **Audit log** entries are written inside the same transaction as the change for account changes, self-registrations, assignments, reassignments, PIN lockouts, trip starts (including support overrides), completions and cancellations. Sensitive keys are redacted.

## Project layout

```
server/src
  domain.ts            state machines and enums
  models/              Mongoose schemas and indexes
  services/            business logic (auth, SSO + self-registration, employees, fleet, booking, assignment, trip/PIN,
                       notifications + email outbox, monitors, reports, SSO)
  routes/              HTTP layer (auth, admin, ops, me, driver, notifications)
  middleware/          auth, CSRF, validation, rate limits, errors
  scripts/             seed, migrate, index sync
server/test            Vitest suites (auth, employees, booking, assignment, trip, fleet,
                       notifications, full end-to-end workflow)
client/src
  lib/                 API client, auth, realtime, hooks
  components/          UI kit and role-aware layout
  pages/               public, common, admin, ops (coordinator+admin), employee, driver
docs/                  deployment, operations runbook, production checklist
```

## Further documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): production deployment, secrets, migrations, backups, rollback and incident recovery.
- [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md): external credentials and administrator approvals, plus the go-live checklist.

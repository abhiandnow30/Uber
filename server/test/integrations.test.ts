import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationResult } from '@azure/msal-node';

import { config } from '../src/config.js';
import { Employee } from '../src/models/Employee.js';
import { EmailOutbox } from '../src/models/system.js';
import { User } from '../src/models/User.js';
import { processOutboxBatch } from '../src/services/email/outbox.worker.js';
import { EmailSendError, GraphEmailProvider, setEmailProvider, SmtpEmailProvider, type SmtpTransport } from '../src/services/email/providers.js';
import { smtpFrom } from '../src/services/email/smtp.js';
import { enqueueEmail } from '../src/services/notification.service.js';
import { buildLoginUrl, completeLogin, issueRegistrationTicket, setSsoClient } from '../src/services/sso.service.js';
import { AuthToken } from '../src/models/system.js';
import { anonymous, drainOutbox, fakeEmail, linkFrom, login, makeAdmin, makeEmployee, makeUser, PASSWORD } from './helpers.js';

// ===========================================================================
// Microsoft Graph sendMail provider (fetch is stubbed; no network)
// ===========================================================================
const opts = { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1', sender: 'transport@company.com' };
const email = { to: 'asha@company.com', subject: 'Your Cab Has Been Assigned', html: '<p>hi</p>', text: 'hi', idempotencyKey: 'cab-assigned:1' };
const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
const accepted = () => new Response(null, { status: 202, headers: { 'request-id': 'graph-req-1' } });

describe('Microsoft Graph email provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('gets a client-credentials token, sends via /users/{sender}/sendMail, and caches the token', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(accepted()).mockResolvedValueOnce(accepted());
    const p = new GraphEmailProvider(opts);
    const r = await p.send(email);
    expect(r.providerMessageId).toBe('graph-req-1');
    await p.send(email);
    expect(fetchMock).toHaveBeenCalledTimes(3); // token fetched once

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(String(tokenInit.body)).toContain('grant_type=client_credentials');
    expect(String(tokenInit.body)).toContain('scope=https%3A%2F%2Fgraph.microsoft.com%2F.default');

    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe('https://graph.microsoft.com/v1.0/users/transport%40company.com/sendMail');
    expect(sendInit.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(sendInit.body);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'asha@company.com' } }]);
    expect(body.message.body.contentType).toBe('HTML');
    expect(body.saveToSentItems).toBe(true);
  });

  it('treats 429 as transient and honours Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response('throttled', { status: 429, headers: { 'retry-after': '120' } }));
    const err = await new GraphEmailProvider(opts).send(email).catch((e) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err.transient).toBe(true);
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('treats 5xx and network errors as transient, 400 as permanent', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response('down', { status: 503 }));
    expect((await new GraphEmailProvider(opts).send(email).catch((e) => e)).transient).toBe(true);
    fetchMock.mockResolvedValueOnce(tokenOk()).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await new GraphEmailProvider(opts).send(email).catch((e) => e)).transient).toBe(true);
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response('{"error":{"code":"ErrorInvalidRecipients"}}', { status: 400 }));
    const perm = await new GraphEmailProvider(opts).send(email).catch((e) => e);
    expect(perm.transient).toBe(false);
    expect(perm.message).toContain('ErrorInvalidRecipients');
  });

  it('on 401 drops the cached token so the retry re-authenticates', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok-2', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(accepted());
    const p = new GraphEmailProvider(opts);
    expect((await p.send(email).catch((e) => e)).transient).toBe(true);
    await p.send(email);
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('a rejected token request (bad secret) is a permanent failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_client"}', { status: 401 }));
    const err = await new GraphEmailProvider(opts).send(email).catch((e) => e);
    expect(err.transient).toBe(false);
    expect(err.message).toContain('invalid_client');
  });

  it('outbox + Graph: throttling becomes RETRYING (no later than Retry-After), then ACCEPTED, never DELIVERED', async () => {
    setEmailProvider(new GraphEmailProvider(opts));
    await enqueueEmail(null, { idempotencyKey: 'g1', template: 'TRIP_COMPLETED', to: 'asha@company.com', params: { name: 'Asha', reference: 'CB-1' } });
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(new Response('throttled', { status: 429, headers: { 'retry-after': '600' } }));
    await processOutboxBatch();
    let msg = await EmailOutbox.findOne({ idempotencyKey: 'g1' });
    expect(msg!.status).toBe('RETRYING');
    expect(msg!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(Date.now() + 590_000);
    await EmailOutbox.updateOne({ _id: msg!._id }, { $set: { nextAttemptAt: new Date(0) } });
    fetchMock.mockResolvedValueOnce(accepted());
    await processOutboxBatch();
    msg = await EmailOutbox.findOne({ idempotencyKey: 'g1' });
    expect(msg!.status).toBe('ACCEPTED');
    expect(msg!.provider).toBe('microsoft-graph');
    expect(msg!.providerMessageId).toBe('graph-req-1');
    expect(msg!.deliveredAt).toBeFalsy();
  });
});

// ===========================================================================
// Microsoft Entra ID SSO (MSAL mocked)
// ===========================================================================
// Fake MSAL client injected into the SSO service: no network calls.
const msal = { claims: {} as Record<string, unknown>, lastAuthUrlRequest: null as unknown };
const fakeMsal = {
  async getAuthCodeUrl(req: unknown) {
    msal.lastAuthUrlRequest = req;
    return 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize?mock=1';
  },
  async acquireTokenByCode() {
    return { idTokenClaims: msal.claims } as unknown as AuthenticationResult;
  },
};

describe('Entra ID single sign-on', () => {
  const saved = { ...config };
  afterEach(() => setSsoClient(null));
  beforeEach(() => {
    setSsoClient(fakeMsal);
    Object.assign(config, {
      ssoEnabled: true,
      ENTRA_TENANT_ID: 'tenant-1',
      ENTRA_CLIENT_ID: 'app-1',
      ENTRA_CLIENT_SECRET: 's',
      ENTRA_REDIRECT_URI: 'http://localhost:5173/api/auth/sso/callback',
    });
  });
  afterEach(() => Object.assign(config, saved));

  async function signIn(claims: Record<string, unknown>, tamperState = false) {
    msal.claims = claims;
    const { cookieValue } = await buildLoginUrl();
    const { state } = JSON.parse(cookieValue);
    return completeLogin({ code: 'auth-code', state: tamperState ? `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}` : state, cookie: cookieValue });
  }

  it('uses auth code + PKCE with a random state', async () => {
    const { url, cookieValue } = await buildLoginUrl();
    expect(url).toContain('login.microsoftonline.com');
    const req = msal.lastAuthUrlRequest as { codeChallengeMethod: string; state: string; scopes: string[] };
    expect(req.codeChallengeMethod).toBe('S256');
    expect(JSON.parse(cookieValue).state).toBe(req.state);
    expect(req.scopes).toEqual(['openid', 'profile', 'email']);
  });

  it('a valid Microsoft identity without a user record is sent to self-registration, not signed in', async () => {
    const r = await signIn({ oid: 'oid-x', tid: 'tenant-1', preferred_username: 'stranger@company.com', name: 'Stranger' });
    expect(r).toMatchObject({ ok: false, reason: 'register' });
    expect(await User.exists({ email: 'stranger@company.com' })).toBeNull();
  });

  it('self-registration requires every field, then creates an ACTIVE employee bound to the Microsoft account', async () => {
    const existing = await makeEmployee();
    await Employee.updateOne({ _id: existing.employee._id }, { $set: { route: 'LB Nagar Cab' } });
    const r = await signIn({ oid: 'oid-harika', tid: 'tenant-1', preferred_username: 'Harika.Velidi@company.com', name: 'Harika Velidi' });
    if (r.ok || r.reason !== 'register') throw new Error('expected a registration ticket');
    const client = anonymous();
    client.agent.jar.setCookie(`cab_sso_reg=${r.ticket}; Path=/api/auth/sso`);

    const ctx = await client.get('/api/auth/sso/registration').expect(200);
    expect(ctx.body).toMatchObject({ email: 'harika.velidi@company.com', fullName: 'Harika Velidi' });
    expect(ctx.body.routes).toContain('LB Nagar Cab');
    expect(ctx.body.offices.map((o: { code: string }) => o.code)).toContain('HYD');

    const form = { employeeId: '1470', fullName: 'Harika Velidi', phone: '7036580058', officeLocation: 'HYD', route: 'Patancheru Cab', homeAddress: 'Ramky one symphony, Patancheru, 502319' };
    for (const field of ['phone', 'route', 'homeAddress', 'officeLocation', 'employeeId'] as const) {
      const res = await client.post('/api/auth/sso/register', { ...form, [field]: '' });
      expect(res.status, field).toBe(422);
    }
    // The email always comes from Microsoft, never from the form.
    await client.post('/api/auth/sso/register', { ...form, email: 'someone.else@company.com' }).expect(201);

    const emp = await Employee.findOne({ employeeId: '1470' }).lean();
    expect(emp).toMatchObject({ email: 'harika.velidi@company.com', officeLocation: 'HYD', route: 'Patancheru Cab', phone: '7036580058', source: 'SSO' });
    const user = await User.findById(emp!.user).lean();
    expect(user).toMatchObject({ status: 'ACTIVE', entraOid: 'oid-harika', role: 'EMPLOYEE' });
    const me = await client.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe('harika.velidi@company.com');

    // Next time they sign in with Microsoft they go straight in, and can't register twice.
    expect((await signIn({ oid: 'oid-harika', tid: 'tenant-1', preferred_username: 'harika.velidi@company.com' })).ok).toBe(true);
    const again = anonymous();
    again.agent.jar.setCookie(`cab_sso_reg=${issueRegistrationTicket({ oid: 'oid-harika', email: 'harika.velidi@company.com', name: '' })}; Path=/api/auth/sso`);
    expect((await again.post('/api/auth/sso/register', { ...form, employeeId: '9999' })).status).toBe(409);
  });

  it('registration needs a valid, unexpired ticket and rejects taken employee IDs', async () => {
    const client = anonymous();
    expect((await client.get('/api/auth/sso/registration')).status).toBe(401);
    const ticket = issueRegistrationTicket({ oid: 'oid-t', email: 't@company.com', name: 'T' });
    client.agent.jar.setCookie(`cab_sso_reg=${ticket.slice(0, -2)}xx; Path=/api/auth/sso`);
    expect((await client.get('/api/auth/sso/registration')).status).toBe(401);

    const takenId = (await makeEmployee()).employee.employeeId;
    client.agent.jar.setCookie(`cab_sso_reg=${ticket}; Path=/api/auth/sso`);
    const res = await client.post('/api/auth/sso/register', { employeeId: takenId, fullName: 'T Person', phone: '9000000000', officeLocation: 'HYD', route: 'Kondapur Cab', homeAddress: 'Somewhere, Hyderabad' });
    expect(res.status).toBe(409);
    expect(await User.exists({ email: 't@company.com' })).toBeNull();
  });

  it('employees cannot use passwords at all once Microsoft sign-in is on; admins still can', async () => {
    const emp = await makeEmployee({ email: 'pw.emp@company.com' });
    const { client: admin } = await makeAdmin();
    const res = await anonymous().post('/api/auth/login', { email: 'pw.emp@company.com', password: PASSWORD });
    expect(res.status).toBe(401);
    // identical to an unknown account, so the form doesn't reveal who is an employee
    const unknown = await anonymous().post('/api/auth/login', { email: 'nobody@company.com', password: PASSWORD });
    expect(res.body.error.message).toBe(unknown.body.error.message);
    expect(res.body.error.message).toContain('Sign in with Microsoft');
    expect((await User.findById(emp.user._id))!.failedLoginCount ?? 0).toBe(0);

    // no reset email for employees
    await expect((await anonymous().post('/api/auth/password/forgot', { email: 'pw.emp@company.com' })).status).toBeLessThan(300);
    await drainOutbox();
    expect(fakeEmail.to('pw.emp@company.com')).toHaveLength(0);

    // admin-added employees get no activation email; they activate on first Microsoft sign-in
    const created = await admin.post('/api/admin/employees', { employeeId: 'MS1', fullName: 'Ms Only', email: 'ms.only@company.com', officeLocation: 'HYD' });
    expect(created.status).toBe(201);
    await drainOutbox();
    expect(fakeEmail.to('ms.only@company.com')).toHaveLength(0);
    expect(await AuthToken.countDocuments({ user: created.body.user })).toBe(0);
    expect((await admin.post(`/api/admin/employees/${created.body._id}/invitation`)).status).toBe(409);
    expect((await signIn({ oid: 'oid-ms1', tid: 'tenant-1', preferred_username: 'ms.only@company.com' })).ok).toBe(true);

    // the admin password flow is untouched
    expect((await admin.get('/api/auth/me')).status).toBe(200);
  });

  it('activation links already sent to employees stop working once Microsoft sign-in is on', async () => {
    Object.assign(config, { ssoEnabled: false });
    const { client: admin } = await makeAdmin();
    await admin.post('/api/admin/employees', { employeeId: 'OLD1', fullName: 'Old Link', email: 'old.link@company.com', officeLocation: 'HYD' }).expect(201);
    await drainOutbox();
    const token = linkFrom(fakeEmail.to('old.link@company.com')[0], '/activate');
    Object.assign(config, { ssoEnabled: true });
    const res = await anonymous().post('/api/auth/activate', { token, password: 'SomePass2026' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MICROSOFT_SIGN_IN_ONLY');
    expect((await User.findOne({ email: 'old.link@company.com' }))!.status).toBe('INVITED');
  });

  it('employees have no password to change', async () => {
    Object.assign(config, { ssoEnabled: false });
    const emp = await makeEmployee();
    const client = await login(emp.user.email);
    Object.assign(config, { ssoEnabled: true });
    const res = await client.post('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'NewPassword2026' });
    expect(res.status).toBe(403);
  });

  it('admins added on the Admins page sign in with Microsoft; no set-password email is sent', async () => {
    const { client: boot } = await makeAdmin('bootstrap.admin@company.com'); // test admin keeps its password
    const added = await boot.post('/api/admin/admins', { fullName: 'Real Admin', email: 'real.admin@company.com', phone: '9000050005' });
    expect(added.status).toBe(201);
    await drainOutbox();
    expect(fakeEmail.to('real.admin@company.com')).toHaveLength(0);
    expect(await AuthToken.countDocuments({ user: added.body._id })).toBe(0);
    expect((await boot.post(`/api/admin/admins/${added.body._id}/invitation`)).status).toBe(409);

    const r = await signIn({ oid: 'oid-real-admin', tid: 'tenant-1', preferred_username: 'Real.Admin@company.com' });
    expect(r.ok).toBe(true);
    expect(await User.findById(added.body._id).lean()).toMatchObject({ status: 'ACTIVE', entraOid: 'oid-real-admin' });

    // the bootstrap admin's password sign-in still works, so it can be removed later by the real admins
    expect((await anonymous().post('/api/auth/login', { email: 'bootstrap.admin@company.com', password: PASSWORD })).status).toBe(200);
  });

  it('drivers cannot sign in with Microsoft either', async () => {
    await makeUser('DRIVER', 'ramesh.driver@company.com');
    expect(await signIn({ oid: 'oid-drv', tid: 'tenant-1', preferred_username: 'ramesh.driver@company.com' })).toEqual({ ok: false, reason: 'driver_mobile_only' });
  });

  it('only company email domains may self-register', async () => {
    const saved = config.allowedEmailDomains;
    config.allowedEmailDomains = ['company.com'];
    try {
      expect(await signIn({ oid: 'oid-g', tid: 'tenant-1', preferred_username: 'guest@gmail.com' })).toEqual({ ok: false, reason: 'not_registered' });
    } finally {
      config.allowedEmailDomains = saved;
    }
  });

  it('signs in an active user, binds the Entra object id, and later matches by oid', async () => {
    await makeUser('EMPLOYEE', 'asha@company.com');
    const r = await signIn({ oid: 'oid-asha', tid: 'tenant-1', preferred_username: 'Asha@Company.com' });
    expect(r.ok).toBe(true);
    expect((await User.findOne({ email: 'asha@company.com' }))!.entraOid).toBe('oid-asha');
    // email changed upstream, still the same person by oid
    const again = await signIn({ oid: 'oid-asha', tid: 'tenant-1', preferred_username: 'asha.rao@company.com' });
    expect(again.ok).toBe(true);
  });

  it('first SSO sign-in activates an INVITED (admin-approved) account', async () => {
    await makeUser('EMPLOYEE', 'new@company.com', { status: 'INVITED' });
    const r = await signIn({ oid: 'oid-new', tid: 'tenant-1', email: 'new@company.com' });
    expect(r.ok).toBe(true);
    const u = await User.findOne({ email: 'new@company.com' });
    expect(u!.status).toBe('ACTIVE');
    expect(u!.activatedAt).toBeInstanceOf(Date);
  });

  it('rejects other tenants, tampered state and inactive accounts', async () => {
    await makeUser('EMPLOYEE', 'asha@company.com');
    await makeUser('EMPLOYEE', 'gone@company.com', { status: 'SUSPENDED' });
    expect(await signIn({ oid: 'o1', tid: 'other-tenant', preferred_username: 'asha@company.com' })).toEqual({ ok: false, reason: 'invalid' });
    expect(await signIn({ oid: 'o1', tid: 'tenant-1', preferred_username: 'asha@company.com' }, true)).toEqual({ ok: false, reason: 'invalid' });
    expect(await signIn({ oid: 'o2', tid: 'tenant-1', preferred_username: 'gone@company.com' })).toEqual({ ok: false, reason: 'inactive' });
  });

  it('an Entra account cannot take over a user already bound to a different object id', async () => {
    const u = await makeUser('EMPLOYEE', 'asha@company.com');
    await User.updateOne({ _id: u._id }, { $set: { entraOid: 'oid-real' } });
    const r = await signIn({ oid: 'oid-attacker', tid: 'tenant-1', preferred_username: 'asha@company.com' });
    expect(r).toEqual({ ok: false, reason: 'not_registered' });
  });
});

// ===========================================================================
// SMTP provider (transport is faked; no network)
// ===========================================================================
describe('SMTP email provider', () => {
  const smtpOpts = { from: 'Cab Booking <bot@company.com>' };
  const failWith = (e: object): SmtpTransport => ({ sendMail: async () => Promise.reject(Object.assign(new Error('boom'), e)) });

  it('sends from the configured sender and returns the message id', async () => {
    const sent: unknown[] = [];
    const p = new SmtpEmailProvider({ sendMail: async (m) => (sent.push(m), { messageId: '<abc@smtp>' }) }, smtpOpts.from);
    expect(await p.send(email)).toEqual({ providerMessageId: '<abc@smtp>' });
    expect(sent[0]).toMatchObject({ from: 'Cab Booking <bot@company.com>', to: email.to, subject: email.subject, html: email.html, text: email.text, headers: { 'X-Cab-Notification-Id': email.idempotencyKey } });
  });

  it('SMTP_FROM can be a full address, a bare display name, or blank (falls back to SMTP_USER)', () => {
    const saved = { SMTP_FROM: config.SMTP_FROM, SMTP_USER: config.SMTP_USER };
    try {
      Object.assign(config, { SMTP_USER: 'bot@company.com', SMTP_FROM: 'Cab Booking <noreply@company.com>' });
      expect(smtpFrom()).toBe('Cab Booking <noreply@company.com>');
      Object.assign(config, { SMTP_FROM: 'NeutaraCabs' });
      expect(smtpFrom()).toEqual({ name: 'NeutaraCabs', address: 'bot@company.com' });
      Object.assign(config, { SMTP_FROM: '' });
      expect(smtpFrom()).toBe('bot@company.com');
    } finally {
      Object.assign(config, saved);
    }
  });

  it('retries temporary failures but not permanent ones', async () => {
    const outcome = async (t: SmtpTransport) => {
      try {
        await new SmtpEmailProvider(t, smtpOpts.from).send(email);
        return 'sent';
      } catch (e) {
        expect(e).toBeInstanceOf(EmailSendError);
        return (e as EmailSendError).transient ? 'retry' : 'fail';
      }
    };
    expect(await outcome(failWith({ code: 'ECONNECTION' }))).toBe('retry'); // network
    expect(await outcome(failWith({ responseCode: 451 }))).toBe('retry'); // server busy
    expect(await outcome(failWith({ code: 'EAUTH', responseCode: 535 }))).toBe('fail'); // wrong password
    expect(await outcome(failWith({ code: 'EENVELOPE', responseCode: 550 }))).toBe('fail'); // bad recipient
  });
});

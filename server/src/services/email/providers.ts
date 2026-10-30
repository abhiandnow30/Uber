import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SendMailOptions } from 'nodemailer';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getSmtpTransport, smtpFrom } from './smtp.js';

export type OutgoingEmail = { to: string; subject: string; html: string; text: string; idempotencyKey: string };
export type SendResult = { providerMessageId?: string };

export class EmailSendError extends Error {
  constructor(
    message: string,
    public transient: boolean,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
}

/**
 * Development provider: writes each email as an HTML file under server/.dev-mailbox
 * so links in emails can be opened locally. Never used in production.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  private dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.dev-mailbox');

  async send(email: OutgoingEmail): Promise<SendResult> {
    await fs.mkdir(this.dir, { recursive: true });
    const safeTo = email.to.replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeTo}.html`);
    await fs.writeFile(file, `<!-- To: ${email.to} | Subject: ${email.subject} -->\n${email.html}`, 'utf8');
    logger.info({ to: email.to, subject: email.subject, file }, '[MOCK EMAIL] written to dev mailbox');
    return { providerMessageId: `mock-${path.basename(file)}` };
  }
}

/**
 * Microsoft Graph sendMail using the OAuth2 client-credentials flow.
 * Requires an Entra ID app registration with the Mail.Send *application* permission
 * (admin consent) and, strongly recommended, an Exchange Online
 * ApplicationAccessPolicy restricting it to GRAPH_SENDER_MAILBOX.
 *
 * Graph returns 202 Accepted: that is acceptance for delivery, NOT proof of delivery.
 */
export class GraphEmailProvider implements EmailProvider {
  readonly name = 'microsoft-graph';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private opts = {
      tenantId: config.GRAPH_TENANT_ID,
      clientId: config.GRAPH_CLIENT_ID,
      clientSecret: config.GRAPH_CLIENT_SECRET,
      sender: config.GRAPH_SENDER_MAILBOX,
    },
  ) {}

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    let res: Response;
    try {
      res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new EmailSendError(`Token request failed: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const transient = res.status >= 500 || res.status === 429;
      const detail = await res.text().catch(() => '');
      throw new EmailSendError(`Token request rejected (${res.status}): ${detail.slice(0, 300)}`, transient);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  async send(email: OutgoingEmail): Promise<SendResult> {
    const token = await this.getToken();
    const clientRequestId = crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.opts.sender)}/sendMail`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'client-request-id': clientRequestId,
          'return-client-request-id': 'true',
        },
        body: JSON.stringify({
          message: {
            subject: email.subject,
            body: { contentType: 'HTML', content: email.html },
            toRecipients: [{ emailAddress: { address: email.to } }],
            internetMessageHeaders: [{ name: 'X-Cab-Notification-Id', value: email.idempotencyKey.slice(0, 200) }],
          },
          saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new EmailSendError(`Graph request failed: ${(err as Error).message}`, true);
    }
    if (res.status === 202) {
      return { providerMessageId: res.headers.get('request-id') ?? clientRequestId };
    }
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 401) this.token = null;
    const retryAfter = Number(res.headers.get('retry-after'));
    const transient = res.status === 429 || res.status >= 500 || res.status === 401;
    throw new EmailSendError(
      `Graph sendMail failed (${res.status}): ${detail}`,
      transient,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
}

/** The part of a nodemailer transport the provider uses (injectable for tests). */
export type SmtpTransport = { sendMail(mail: SendMailOptions): Promise<{ messageId?: string }> };

/**
 * Queue sender for EMAIL_MODE=smtp, using the shared transport in ./smtp.ts. Unlike
 * sendMail() there, it throws on failure so the outbox worker can retry. The server's
 * "250 queued" reply is acceptance for delivery, not proof of delivery.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';

  constructor(
    private transport: SmtpTransport = getSmtpTransport(),
    private from: SendMailOptions['from'] = smtpFrom(),
  ) {}

  async send(email: OutgoingEmail): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers: { 'X-Cab-Notification-Id': email.idempotencyKey.slice(0, 200) },
      });
      logger.info({ messageId: info.messageId }, `Email sent to ${email.to}`);
      return { providerMessageId: info.messageId };
    } catch (err) {
      const e = err as { message?: string; code?: string; responseCode?: number };
      // 4xx replies and network problems are temporary; 5xx replies (bad recipient, rejected
      // login, message refused) won't fix themselves and need an admin to look.
      const transient = e.responseCode ? e.responseCode < 500 : e.code !== 'EAUTH' && e.code !== 'EENVELOPE';
      throw new EmailSendError(`SMTP send failed${e.responseCode ? ` (${e.responseCode})` : ''}: ${(e.message ?? 'unknown error').slice(0, 300)}`, transient);
    }
  }
}

let provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (!provider) {
    provider =
      config.EMAIL_MODE === 'graph' ? new GraphEmailProvider() : config.EMAIL_MODE === 'smtp' ? new SmtpEmailProvider() : new MockEmailProvider();
  }
  return provider;
}

/** Test hook. */
export function setEmailProvider(p: EmailProvider | null) {
  provider = p;
}

import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

let transport: Transporter | null = null;

/** One shared SMTP transport, created on first use from the SMTP_* settings. */
export function getSmtpTransport(): Transporter {
  if (transport) return transport;
  if (!config.SMTP_HOST) throw new Error('SMTP is not configured: SMTP_HOST is missing in server/.env');
  const port = config.SMTP_PORT;
  transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port,
    secure: port === 465, // TLS from the first byte only on 465
    requireTLS: port === 587, // STARTTLS must succeed, so the login never goes out unencrypted
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

/**
 * What recipients see as the sender. SMTP_FROM may be "Name <address>" or just a
 * display name (sent from SMTP_USER under that name); blank falls back to SMTP_USER.
 */
export function smtpFrom(): SendMailOptions['from'] {
  const from = config.SMTP_FROM.trim();
  if (!from) return config.SMTP_USER;
  return from.includes('@') ? from : { name: from, address: config.SMTP_USER };
}

const recipients = (to: string | string[]) => (Array.isArray(to) ? to : [to]).map((a) => a.trim()).filter(Boolean);

/**
 * Sends one email. Never throws: failures are logged (never the password) and null is
 * returned, so the request that triggered the email still succeeds.
 */
export async function sendMail(to: string | string[], subject: string, html: string) {
  const list = recipients(to);
  if (!list.length) {
    logger.warn({ subject }, 'Email not sent: no recipient address');
    return null;
  }
  try {
    const info = await getSmtpTransport().sendMail({ from: smtpFrom(), to: list, subject, html });
    logger.info({ accepted: info.accepted, rejected: info.rejected, messageId: info.messageId }, `Email sent to ${list.join(', ')}`);
    return info;
  } catch (err) {
    const e = err as { message?: string; code?: string; responseCode?: number };
    logger.error({ to: list, subject, code: e.code, responseCode: e.responseCode, error: e.message }, 'Email sending failed');
    return null;
  }
}

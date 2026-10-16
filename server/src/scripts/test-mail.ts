/**
 * Checks the SMTP settings and sends one test email.
 *   npm run test-mail -- you@company.com
 * Prints the mail server's reply. Never prints SMTP_PASS.
 */
import { config } from '../config.js';
import { getSmtpTransport, smtpFrom } from '../services/email/smtp.js';

const to = process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
if (!to.length) {
  console.error('Usage: npm run test-mail -- you@company.com');
  process.exit(1);
}

console.log(`SMTP server: ${config.SMTP_HOST || '(SMTP_HOST missing)'}:${config.SMTP_PORT}`);
console.log(`Signing in as: ${config.SMTP_USER || '(no login)'}`);
console.log(`From: ${JSON.stringify(smtpFrom())}`);

try {
  const transport = getSmtpTransport();
  await transport.verify();
  console.log('Login: OK');
  const info = await transport.sendMail({
    from: smtpFrom(),
    to,
    subject: 'Cab Booking test email',
    html: '<p>Hello,</p><p>This is a test email from the Cab Booking application. If you received it, email sending works.</p>',
  });
  console.log('Accepted:', (info.accepted ?? []).join(', ') || '(none)');
  console.log('Rejected:', (info.rejected ?? []).join(', ') || '(none)');
  console.log('Server reply:', info.response);
  transport.close();
} catch (err) {
  const e = err as { message?: string; code?: string; responseCode?: number };
  console.error('FAILED:', [e.code, e.responseCode].filter(Boolean).join(' '), '-', e.message);
  process.exit(1);
}

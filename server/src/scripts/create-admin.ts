/**
 * Bootstrap an administrator account (works in production).
 *
 *   npm run create-admin -w server -- --email it.admin@company.com --name "IT Admin"
 *   node server/dist/scripts/create-admin.js --email ... --name ...      (container)
 *
 * The account is created as INVITED and an activation email is queued; it is sent
 * by the running app's outbox worker (or immediately with --send-now). No password
 * is ever set or printed by this script. If the email already belongs to an INVITED
 * admin, the invitation is re-issued; any other existing account is left untouched.
 */
import { parseArgs } from 'node:util';
import { config } from '../config.js';
import { connectDatabase, disconnectDatabase, withTransaction } from '../db.js';
import { User } from '../models/User.js';
import { audit, SYSTEM_ACTOR } from '../services/audit.service.js';
import { adminsUseMicrosoft, issueActivation, normalizeEmail } from '../services/auth.service.js';
import { processOutboxBatch } from '../services/email/outbox.worker.js';
import { emailDomainAllowed } from '../services/employee.service.js';
import { syncIndexes } from './indexes.js';

export async function createAdmin(emailRaw: string, name: string) {
  const email = normalizeEmail(emailRaw);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error(`Invalid email: ${emailRaw}`);
  if (!emailDomainAllowed(email)) throw new Error(`${email} is not in ALLOWED_EMAIL_DOMAINS`);
  if (name.trim().length < 2) throw new Error('Name is required');
  const actor = { ...SYSTEM_ACTOR, email: 'create-admin-script' };
  return withTransaction(async ({ session }) => {
    const existing = await User.findOne({ email }).session(session);
    if (existing) {
      if (existing.role !== 'ADMIN') throw new Error(`${email} already belongs to an existing ${existing.role.toLowerCase()} account; not changed`);
      if (existing.status !== 'INVITED') throw new Error(`${email} is already an admin with status ${existing.status}; not changed`);
      if (adminsUseMicrosoft()) return { created: false, expiresAt: null };
      const r = await issueActivation(existing, actor, session);
      await audit(actor, 'ADMIN_INVITATION_REISSUED', 'User', existing._id, `Admin invitation re-issued for ${email}`, undefined, session);
      return { created: false, expiresAt: r.expiresAt };
    }
    const [user] = await User.create([{ email, name: name.trim(), role: 'ADMIN', status: 'INVITED', statusChangedAt: new Date() }], { session });
    const r = adminsUseMicrosoft() ? { expiresAt: null } : await issueActivation(user, actor, session);
    await audit(actor, 'ADMIN_BOOTSTRAPPED', 'User', user._id, `Admin account ${email} created by create-admin script`, undefined, session);
    return { created: true, expiresAt: r.expiresAt };
  });
}

const isMain = process.argv[1] && /create-admin\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, 'send-now': { type: 'boolean', default: false } },
  });
  if (!values.email || !values.name) {
    console.error('Usage: create-admin --email <work email> --name "<full name>" [--send-now]');
    process.exit(2);
  }
  try {
    await connectDatabase();
    await syncIndexes();
    const r = await createAdmin(values.email, values.name);
    if (values['send-now']) await processOutboxBatch(5);
    console.log(
      (r.expiresAt === null
        ? `Admin ${r.created ? 'created' : 'already invited'}: ${values.email}. They sign in with "Sign in with Microsoft" using this email.\n`
        : `${r.created ? 'Admin created' : 'Invitation re-issued'} for ${values.email}. Activation link expires ${r.expiresAt.toISOString()}.\n`) +
        (values['send-now'] ? 'Invitation email sent via ' + config.EMAIL_MODE + '.' : 'The invitation email will be sent by the running app (outbox worker).'),
    );
  } catch (err) {
    console.error(`create-admin failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

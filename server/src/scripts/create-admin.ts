/**
 * Bootstrap an administrator account (works in production).
 *
 *   npm run create-admin -w server -- --email it.admin@company.com --name "IT Admin"
 *   node server/dist/scripts/create-admin.js --email ... --name ...      (container)
 *
 * The account is created as INVITED; it becomes active on the admin's first
 * "Sign in with Microsoft" with this email. No email is sent. If the email already
 * belongs to an INVITED admin nothing changes; any other existing account is left untouched.
 */
import { parseArgs } from 'node:util';
import { connectDatabase, disconnectDatabase, withTransaction } from '../db.js';
import { User } from '../models/User.js';
import { audit, SYSTEM_ACTOR } from '../services/audit.service.js';
import { normalizeEmail } from '../services/auth.service.js';
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
      return { created: false };
    }
    const [user] = await User.create([{ email, name: name.trim(), role: 'ADMIN', status: 'INVITED', statusChangedAt: new Date() }], { session });
    await audit(actor, 'ADMIN_BOOTSTRAPPED', 'User', user._id, `Admin account ${email} created by create-admin script`, undefined, session);
    return { created: true };
  });
}

const isMain = process.argv[1] && /create-admin\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  if (!values.email || !values.name) {
    console.error('Usage: create-admin --email <work email> --name "<full name>"');
    process.exit(2);
  }
  try {
    await connectDatabase();
    await syncIndexes();
    const r = await createAdmin(values.email, values.name);
    console.log(`Admin ${r.created ? 'created' : 'already invited'}: ${values.email}. They sign in with "Sign in with Microsoft" using this email.`);
  } catch (err) {
    console.error(`create-admin failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

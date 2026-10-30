import { config } from '../config.js';

export const NOT_REGISTERED_MESSAGE =
  "Your account can't be registered automatically. Please contact your administrator.";

/** Employees sign in only with Microsoft. */
export function employeesUseMicrosoftOnly() {
  return config.ssoEnabled || config.isProd;
}

/** Admins are added by email and sign in with Microsoft. */
export function adminsUseMicrosoft() {
  return config.ssoEnabled;
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase().normalize('NFKC');
}

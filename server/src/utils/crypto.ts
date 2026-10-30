import crypto from 'node:crypto';
import { config } from '../config.js';

/** Opaque random token for sessions and CSRF. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Keyed hash for storing high-entropy tokens (sessions). */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', config.TOKEN_HMAC_KEY).update(token).digest('hex');
}

/** Cryptographically secure numeric PIN with uniform distribution. */
export function generatePin(digits = 4): string {
  const max = 10 ** digits;
  return crypto.randomInt(0, max).toString().padStart(digits, '0');
}

/**
 * Keyed, salted hash for low-entropy PINs. The server-side key (pepper) means a
 * database leak alone does not allow offline brute force of the 10^6 space.
 */
export function hashPin(pin: string, salt: string): string {
  return crypto.createHmac('sha256', config.PIN_HMAC_KEY).update(`${salt}:${pin}`).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** AES-256-GCM encryption for small secrets that must be recoverable by the server. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split('.');
  if (v !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

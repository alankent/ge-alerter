import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Stateless acknowledgement token: HMAC over the user and notification ids. */
export function ackToken(secret: string, uid: string, notificationId: string): string {
  return createHmac('sha256', secret).update(`${uid}\n${notificationId}`).digest('base64url');
}

/** PKCE verification per RFC 7636. */
export function verifyPkce(verifier: string, challenge: string, method: 'S256' | 'plain'): boolean {
  if (method === 'plain') return safeEqual(verifier, challenge);
  return safeEqual(sha256(verifier), challenge);
}

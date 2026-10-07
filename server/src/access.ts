import type { VerifiedUser } from './store/types.js';

/** True when the user's verified email belongs to one of the allowed domains (or no domains are configured). */
export function isAllowedUser(user: VerifiedUser, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  if (!user.email || user.emailVerified !== true) return false;
  const at = user.email.lastIndexOf('@');
  if (at < 0) return false;
  return allowedDomains.includes(user.email.slice(at + 1).toLowerCase());
}

export function allowedDomainsText(allowedDomains: string[]): string {
  return allowedDomains.map((d) => `@${d}`).join(' or ');
}

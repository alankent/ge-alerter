/**
 * Allow-list for the links an agent puts on a notification (the click-through url and the action buttons).
 *
 * send_notification runs without user confirmation (it is annotated read-only so scheduled runs can notify), so an
 * agent steered by injected content could otherwise send the user a convincing notification that opens an attacker's
 * page. Links outside the list are dropped; the notification itself is still delivered.
 *
 * Entries are a host ("vertexaisearch.cloud.google.com"), a wildcard host ("*.imdigital.com", which also matches
 * imdigital.com itself), or either followed by a path prefix ("vertexaisearch.cloud.google.com/home/cid/123/").
 * The app's own origin is always allowed. An empty list allows any link.
 */
export function parseAllowedLinks(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^https:\/\//i, ''))
    .filter(Boolean);
}

export function isAllowedLink(url: string, allowed: string[], appUrl: string): boolean {
  if (allowed.length === 0) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin === new URL(appUrl).origin) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return allowed.some((entry) => {
    const slash = entry.indexOf('/');
    const pattern = (slash < 0 ? entry : entry.slice(0, slash)).toLowerCase();
    const prefix = slash < 0 ? '/' : entry.slice(slash);
    const hostOk = pattern.startsWith('*.') ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern;
    return hostOk && u.pathname.startsWith(prefix);
  });
}

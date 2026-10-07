// Writes database.rules.json from database.rules.template.json, restricting access to the
// email domains in ALLOWED_EMAIL_DOMAINS (comma-separated). Empty allows any signed-in user.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);
for (const d of domains) {
  if (!/^[a-z0-9.-]+$/.test(d)) throw new Error(`Invalid domain: ${d}`);
}

const escape = (d) => d.replace(/\./g, '\\.');
const condition = domains.length
  ? `&& auth.token.email_verified == true && auth.token.email.matches(/^[^@]+@(${domains.map(escape).join('|')})$/)`
  : '';

const template = JSON.parse(readFileSync(join(root, 'database.rules.template.json'), 'utf8'));
delete template['//'];
const fill = (v) =>
  typeof v === 'string' ? v.replace('__ALLOWED_EMAIL__', condition).trim()
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
  : v;
writeFileSync(join(root, 'database.rules.json'), JSON.stringify(fill(template), null, 2) + '\n');
console.log(`database.rules.json written (${domains.length ? domains.join(', ') : 'any signed-in user'})`);

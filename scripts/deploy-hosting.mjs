// Deploys a directory to a Firebase Hosting site through the Hosting REST API, so no Firebase CLI
// (and no key file) is needed. Mirrors `firebase deploy --only hosting` for the config in firebase.json.
//
//   node scripts/deploy-hosting.mjs <siteId> <directory>
//
// Auth: set GOOGLE_ACCESS_TOKEN (e.g. from `gcloud auth print-access-token`). It may be a
// placeholder when a network proxy attaches the real credentials to *.googleapis.com requests.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const [siteId, directory] = process.argv.slice(2);
if (!siteId || !directory) {
  console.error('usage: node scripts/deploy-hosting.mjs <siteId> <directory>');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hosting = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8')).hosting ?? {};
const API = 'https://firebasehosting.googleapis.com/v1beta1';
const token = process.env.GOOGLE_ACCESS_TOKEN;

async function call(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// firebase.json headers are [{source, headers:[{key,value}]}]; the API wants [{glob, headers:{key:value}}].
const config = {
  cleanUrls: hosting.cleanUrls ?? false,
  ...(hosting.trailingSlash !== undefined && { trailingSlashBehavior: hosting.trailingSlash ? 'ADD' : 'REMOVE' }),
  headers: (hosting.headers ?? []).map((h) => ({
    glob: h.source,
    headers: Object.fromEntries(h.headers.map(({ key, value }) => [key, value])),
  })),
  redirects: (hosting.redirects ?? []).map((r) => ({ glob: r.source, location: r.destination, statusCode: r.type ?? 301 })),
  rewrites: (hosting.rewrites ?? []).filter((r) => r.destination).map((r) => ({ glob: r.source, path: r.destination })),
};
const ignore = hosting.ignore ?? ['**/.*', '**/node_modules/**'];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
const files = new Map(); // "/path" -> gzipped bytes
for (const full of walk(directory)) {
  const rel = relative(directory, full).split('\\').join('/');
  if (ignore.some((pattern) => matchesGlob(rel, pattern) || matchesGlob(posix.basename(rel), pattern))) continue;
  files.set('/' + rel, gzipSync(readFileSync(full), { level: 9 }));
}
if (files.size === 0) throw new Error(`No files to deploy in ${directory}`);

const hashes = new Map(); // "/path" -> sha256 of the gzipped bytes
for (const [path, gz] of files) hashes.set(path, createHash('sha256').update(gz).digest('hex'));

const version = await call('POST', `${API}/sites/${siteId}/versions`, { config });
console.log(`  version ${version.name.split('/').pop()} (${files.size} files)`);

const populate = await call('POST', `${API}/${version.name}:populateFiles`, { files: Object.fromEntries(hashes) });
const required = new Set(populate.uploadRequiredHashes ?? []);
let uploaded = 0;
for (const [path, gz] of files) {
  const hash = hashes.get(path);
  if (!required.has(hash)) continue;
  await call('POST', `${populate.uploadUrl}/${hash}`, gz, { 'Content-Type': 'application/octet-stream' });
  required.delete(hash); // the same content may appear under several paths
  uploaded++;
}
console.log(`  uploaded ${uploaded} new files`);

await call('PATCH', `${API}/${version.name}?updateMask=status`, { status: 'FINALIZED' });
const release = await call('POST', `${API}/sites/${siteId}/releases?versionName=${version.name}`, {});
console.log(`  released ${release.name.split('/').pop()} -> https://${siteId}.web.app`);

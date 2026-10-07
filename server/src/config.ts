/**
 * Runtime configuration, read once from environment variables.
 *
 * Everything the server needs to know about where it lives, where the PWA
 * lives, and which OAuth client Gemini Enterprise has been configured with.
 */
export interface Config {
  /** Port to listen on. Cloud Run sets PORT. */
  port: number;
  /** Public base URL of this server, no trailing slash (used in OAuth metadata and ack links). */
  publicUrl: string;
  /** Public origin of the PWA, no trailing slash (consent page + CORS). */
  webUrl: string;
  /** OAuth client credentials that Gemini Enterprise presents. */
  oauthClientId: string;
  oauthClientSecret: string;
  /** Human readable client name shown on the consent page. */
  oauthClientName: string;
  /** Exact redirect URIs the OAuth client may use. */
  oauthRedirectUris: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Secret used to sign per-notification acknowledgement links. */
  ackSecret: string;
  /** Which backing store to use. */
  store: 'firebase' | 'memory';
  firebaseDatabaseUrl?: string;
  firebaseProjectId?: string;
}

export const GEMINI_ENTERPRISE_REDIRECT_URI = 'https://vertexaisearch.cloud.google.com/oauth-redirect';

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const store = (env.STORE ?? 'firebase') as Config['store'];
  if (store !== 'firebase' && store !== 'memory') {
    throw new Error(`STORE must be "firebase" or "memory", got "${store}"`);
  }

  const port = intEnv(env, 'PORT', 8080);
  const publicUrl = stripSlash(env.PUBLIC_URL ?? `http://localhost:${port}`);
  const webUrl = stripSlash(env.WEB_URL ?? 'http://localhost:3000');

  const oauthClientId = env.OAUTH_CLIENT_ID ?? '';
  const oauthClientSecret = env.OAUTH_CLIENT_SECRET ?? '';
  if (store === 'firebase' && (!oauthClientId || !oauthClientSecret)) {
    throw new Error('OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are required');
  }

  const redirectUris = (env.OAUTH_REDIRECT_URIS ?? GEMINI_ENTERPRISE_REDIRECT_URI)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (store === 'firebase' && !env.FIREBASE_DATABASE_URL) {
    throw new Error('FIREBASE_DATABASE_URL is required when STORE=firebase');
  }

  return {
    port,
    publicUrl,
    webUrl,
    oauthClientId: oauthClientId || 'dev-client',
    oauthClientSecret: oauthClientSecret || 'dev-secret',
    oauthClientName: env.OAUTH_CLIENT_NAME ?? 'Gemini Enterprise',
    oauthRedirectUris: redirectUris,
    accessTokenTtlSeconds: intEnv(env, 'ACCESS_TOKEN_TTL_SECONDS', 3600),
    refreshTokenTtlSeconds: intEnv(env, 'REFRESH_TOKEN_TTL_SECONDS', 90 * 24 * 3600),
    ackSecret: env.ACK_SECRET ?? oauthClientSecret ?? 'dev-ack-secret',
    store,
    firebaseDatabaseUrl: env.FIREBASE_DATABASE_URL,
    firebaseProjectId: env.FIREBASE_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT,
  };
}

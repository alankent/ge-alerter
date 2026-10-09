/**
 * A deliberately small OAuth 2.0 authorization server.
 *
 * Two kinds of client:
 *   - the static client (OAUTH_CLIENT_ID + secret), which Gemini Enterprise needs because it does not do dynamic
 *     client registration;
 *   - dynamically registered clients (RFC 7591), which is how Claude connects without a secret. They are public
 *     clients by default, must use PKCE (S256) and may only return to the redirect URIs in DCR_REDIRECT_URIS
 *     (Claude's callbacks) or a loopback address on the user's machine (RFC 8252, any port).
 * Either way the consent screen is the PWA: the user signs in with Google there, approves, and the PWA calls back
 * here to turn the pending request into an authorization code. Tokens are opaque random strings stored hashed.
 */
import { Router, type Request, type Response } from 'express';
import type { Config } from './config.js';
import { allowedDomainsText, isAllowedUser } from './access.js';
import { randomToken, safeEqual, sha256, verifyPkce } from './crypto.js';
import type { Identity, RegisteredClient, Store, VerifiedUser } from './store/types.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
export const SCOPES = ['notifications'];

interface Deps {
  config: Config;
  store: Store;
  identity: Identity;
}

export function authorizationServerMetadata(config: Config) {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', ...(config.dynamicRegistration ? ['none'] : [])],
    ...(config.dynamicRegistration ? { registration_endpoint: `${config.publicUrl}/oauth/register` } : {}),
    scopes_supported: SCOPES,
  };
}

function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!isLoopback(registered) || !isLoopback(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const DYNAMIC_PREFIX = 'dyn_';

export function protectedResourceMetadata(config: Config) {
  return {
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: [config.publicUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  };
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function errorPage(res: Response, status: number, message: string) {
  res
    .status(status)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><title>Authorization error</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:36rem"><h1>Authorization error</h1><p>${escapeHtml(message)}</p></body>`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Reads client credentials from HTTP Basic or the form body. */
function readClientCredentials(req: Request): { clientId?: string; clientSecret?: string } {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, idx)),
        clientSecret: decodeURIComponent(decoded.slice(idx + 1)),
      };
    }
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  return { clientId: firstString(body.client_id), clientSecret: firstString(body.client_secret) };
}

/**
 * Who is asking, for the consent page. One OAuth client serves Gemini Enterprise, Claude and Claude Code; they are
 * told apart by the redirect URI they registered.
 */
export function requesterName(redirectUri: string, fallback: string): string {
  let host = '';
  try {
    host = new URL(redirectUri).hostname;
  } catch {
    return fallback;
  }
  if (host === 'vertexaisearch.cloud.google.com') return 'Gemini Enterprise';
  if (host === 'claude.ai' || host === 'claude.com') return 'Claude';
  // Any app on the user's computer can use a loopback address, so do not claim it is Claude Code.
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return 'An app on your computer (such as Claude Code)';
  return fallback;
}

export function createOAuthRouter({ config, store, identity }: Deps): Router {
  const router = Router();

  async function dynamicClient(clientId: string | undefined): Promise<RegisteredClient | null> {
    if (!config.dynamicRegistration || !clientId?.startsWith(DYNAMIC_PREFIX)) return null;
    return store.getClient(clientId);
  }

  /** Dynamic client registration (RFC 7591), used by Claude. */
  router.post('/oauth/register', async (req, res) => {
    if (!config.dynamicRegistration) return oauthError(res, 404, 'not_found', 'Dynamic client registration is turned off');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (redirectUris.length === 0 || redirectUris.length > 5) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'Provide between one and five redirect_uris');
    }
    const refused = redirectUris.filter((u) => !config.dynamicRedirectUris.includes(u) && !isLoopback(u));
    if (refused.length) {
      return oauthError(res, 400, 'invalid_redirect_uri', `These redirect URIs are not allowed for registered clients: ${refused.join(', ')}`);
    }
    const requested = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
    if (!(AUTH_METHODS as readonly string[]).includes(requested)) {
      return oauthError(res, 400, 'invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${requested}`);
    }
    const method = requested as RegisteredClient['tokenEndpointAuthMethod'];
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : undefined;
    const clientId = DYNAMIC_PREFIX + randomToken(16);
    const clientSecret = method === 'none' ? undefined : randomToken(32);
    const now = Date.now();
    await store.putClient(clientId, {
      ...(clientName ? { clientName } : {}),
      redirectUris,
      tokenEndpointAuthMethod: method,
      ...(clientSecret ? { secretHash: sha256(clientSecret) } : {}),
      createdAt: now,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      ...(clientName ? { client_name: clientName } : {}),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPES.join(' '),
    });
  });

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(authorizationServerMetadata(config));
  });
  router.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json(protectedResourceMetadata(config));
  });
  router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json(protectedResourceMetadata(config));
  });

  /**
   * Step 1: Gemini Enterprise sends the user's browser here. We validate the
   * client and redirect URI, park the request, and bounce to the PWA consent
   * page. Errors in client identity are shown, not redirected (RFC 6749 §4.1.2.1).
   */
  router.get('/oauth/authorize', async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const clientId = firstString(q.client_id);
    const redirectUri = firstString(q.redirect_uri);
    const responseType = firstString(q.response_type);
    const state = firstString(q.state);
    const scope = firstString(q.scope);
    const codeChallenge = firstString(q.code_challenge);
    const codeChallengeMethod = firstString(q.code_challenge_method) ?? (codeChallenge ? 'plain' : undefined);

    const registered = clientId === config.oauthClientId ? null : await dynamicClient(clientId);
    if (!clientId || (clientId !== config.oauthClientId && !registered)) {
      return errorPage(res, 400, 'Unknown client_id. Check the OAuth client ID in the connector settings, or remove and re-add the connector.');
    }
    const allowedRedirects = registered ? registered.redirectUris : config.oauthRedirectUris;
    const effectiveRedirect = redirectUri ?? (allowedRedirects.length === 1 ? allowedRedirects[0] : undefined);
    if (!effectiveRedirect || !allowedRedirects.some((r) => (registered ? redirectMatches(r, effectiveRedirect) : r === effectiveRedirect))) {
      return errorPage(res, 400, `redirect_uri is not registered for this client: ${redirectUri ?? '(missing)'}`);
    }

    const redirectWithError = (error: string, description: string) => {
      const u = new URL(effectiveRedirect);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (state) u.searchParams.set('state', state);
      res.redirect(302, u.toString());
    };

    if (responseType !== 'code') return redirectWithError('unsupported_response_type', 'Only response_type=code is supported');
    if (codeChallengeMethod && codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
      return redirectWithError('invalid_request', 'Unsupported code_challenge_method');
    }
    if (registered && (!codeChallenge || codeChallengeMethod !== 'S256')) {
      return redirectWithError('invalid_request', 'Registered clients must use PKCE with S256');
    }

    const id = randomToken(24);
    await store.putPendingAuth(id, {
      clientId,
      redirectUri: effectiveRedirect,
      state,
      scope,
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod as 'S256' | 'plain' | undefined,
      exp: Date.now() + PENDING_TTL_MS,
    });

    const consent = new URL('/connect', config.webUrl + '/');
    consent.searchParams.set('request', id);
    res.redirect(302, consent.toString());
  });

  /** Lets the consent page describe what is being approved. */
  router.get('/oauth/request/:id', async (req, res) => {
    const pending = await store.peekPendingAuth(req.params.id as string);
    if (!pending || pending.exp < Date.now()) {
      return oauthError(res, 404, 'not_found', 'This authorization request has expired. Start the connection again.');
    }
    res.json({
      clientId: pending.clientId,
      clientName: requesterName(pending.redirectUri, config.oauthClientName),
      allowedEmailDomains: config.allowedEmailDomains,
      scope: pending.scope ?? SCOPES.join(' '),
      expiresAt: pending.exp,
    });
  });

  /**
   * Step 2: the PWA posts the signed-in user's decision. On approval we mint
   * a one-time code bound to the user and hand back the redirect URL.
   */
  router.post('/oauth/decision', async (req, res) => {
    const header = req.headers.authorization ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      return oauthError(res, 401, 'unauthorized', 'Missing Firebase ID token');
    }
    let user: VerifiedUser;
    try {
      user = await identity.verifyIdToken(header.slice(7).trim());
    } catch {
      return oauthError(res, 401, 'unauthorized', 'Invalid Firebase ID token');
    }
    if (!isAllowedUser(user, config.allowedEmailDomains)) {
      return oauthError(res, 403, 'forbidden', `Only ${allowedDomainsText(config.allowedEmailDomains)} accounts can connect.`);
    }

    const body = (req.body ?? {}) as { request?: unknown; approve?: unknown };
    const requestId = firstString(body.request);
    if (!requestId) return oauthError(res, 400, 'invalid_request', 'Missing request id');

    const pending = await store.takePendingAuth(requestId);
    if (!pending || pending.exp < Date.now()) {
      return oauthError(res, 404, 'not_found', 'This authorization request has expired. Start the connection again.');
    }

    const redirect = new URL(pending.redirectUri);
    if (pending.state) redirect.searchParams.set('state', pending.state);

    if (body.approve !== true) {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', 'The user declined the request');
      return res.json({ redirectUrl: redirect.toString(), approved: false });
    }

    const code = randomToken(32);
    await store.putCode(sha256(code), {
      uid: user.uid,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      scope: pending.scope,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      exp: Date.now() + CODE_TTL_MS,
    });
    redirect.searchParams.set('code', code);
    res.json({ redirectUrl: redirect.toString(), approved: true });
  });

  /** Step 3: Gemini Enterprise's backend exchanges the code (or a refresh token). */
  router.post('/oauth/token', async (req, res) => {
    const { clientId, clientSecret } = readClientCredentials(req);
    const registered = clientId === config.oauthClientId ? null : await dynamicClient(clientId);
    const authenticated =
      clientId === config.oauthClientId
        ? Boolean(clientSecret) && safeEqual(clientSecret as string, config.oauthClientSecret)
        : registered
          ? registered.tokenEndpointAuthMethod === 'none' || (Boolean(clientSecret) && safeEqual(sha256(clientSecret as string), registered.secretHash ?? ''))
          : false;
    if (!clientId || !authenticated) {
      res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
      return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = firstString(body.grant_type);
    const now = Date.now();

    const issue = async (uid: string, scope: string | undefined, refreshToken?: string) => {
      const accessToken = randomToken(32);
      await store.putAccessToken(sha256(accessToken), {
        uid,
        clientId,
        scope,
        exp: now + config.accessTokenTtlSeconds * 1000,
      });
      if (!refreshToken) {
        refreshToken = randomToken(32);
        await store.putRefreshToken(sha256(refreshToken), {
          uid,
          clientId,
          scope,
          exp: now + config.refreshTokenTtlSeconds * 1000,
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: config.accessTokenTtlSeconds,
        refresh_token: refreshToken,
        scope: scope ?? SCOPES.join(' '),
      });
    };

    if (grantType === 'authorization_code') {
      const code = firstString(body.code);
      if (!code) return oauthError(res, 400, 'invalid_request', 'Missing code');
      const record = await store.takeCode(sha256(code));
      if (!record || record.exp < now) return oauthError(res, 400, 'invalid_grant', 'Code is invalid or expired');
      if (record.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'Code was issued to a different client');
      const redirectUri = firstString(body.redirect_uri);
      if (redirectUri && redirectUri !== record.redirectUri) {
        return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
      }
      if (registered && !record.codeChallenge) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE is required for registered clients');
      }
      if (record.codeChallenge) {
        const verifier = firstString(body.code_verifier);
        if (!verifier || !verifyPkce(verifier, record.codeChallenge, record.codeChallengeMethod ?? 'plain')) {
          return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
        }
      }
      return issue(record.uid, record.scope);
    }

    if (grantType === 'refresh_token') {
      const refreshToken = firstString(body.refresh_token);
      if (!refreshToken) return oauthError(res, 400, 'invalid_request', 'Missing refresh_token');
      const record = await store.getRefreshToken(sha256(refreshToken));
      if (!record || record.exp < now) {
        if (record) await store.deleteRefreshToken(sha256(refreshToken));
        return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      }
      if (record.clientId !== clientId) return oauthError(res, 400, 'invalid_grant', 'Refresh token was issued to a different client');
      return issue(record.uid, record.scope, refreshToken);
    }

    return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  return router;
}

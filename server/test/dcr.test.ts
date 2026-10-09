import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ID_TOKEN, WEB_URL, startTestServer, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await startTestServer();
});
afterEach(() => ctx.close());

const VERIFIER = 'claude-pkce-verifier-0123456789-0123456789-0123456789';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

async function register(body: Record<string, unknown>) {
  const r = await fetch(`${ctx.baseUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

/** Authorize + consent; returns the authorize response, or the code when it redirected to the consent page. */
async function authorize(clientId: string, redirectUri: string, pkce = true) {
  const url = new URL('/oauth/authorize', ctx.baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', 's1');
  if (pkce) {
    url.searchParams.set('code_challenge', CHALLENGE);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  const r = await fetch(url, { redirect: 'manual' });
  const location = new URL(r.headers.get('location') ?? 'http://none/');
  if (r.status !== 302 || location.origin !== WEB_URL) return { status: r.status, location, code: undefined };
  const requestId = location.searchParams.get('request') as string;
  const info = (await (await fetch(`${ctx.baseUrl}/oauth/request/${requestId}`)).json()) as { clientName: string };
  const d = await fetch(`${ctx.baseUrl}/oauth/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}` },
    body: JSON.stringify({ request: requestId, approve: true }),
  });
  const { redirectUrl } = (await d.json()) as { redirectUrl: string };
  return { status: r.status, location, code: new URL(redirectUrl).searchParams.get('code') as string, redirectUrl, clientName: info.clientName };
}

async function token(params: Record<string, string>) {
  const r = await fetch(`${ctx.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe('dynamic client registration (Claude)', () => {
  it('is advertised in the authorization server metadata', async () => {
    const meta = (await (await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBe(`${ctx.baseUrl}/oauth/register`);
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('registers a public client and completes the flow with PKCE and no secret', async () => {
    const reg = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'none' });
    expect(reg.status).toBe(201);
    expect(reg.body.client_secret).toBeUndefined();
    expect(reg.body.token_endpoint_auth_method).toBe('none');
    const clientId = reg.body.client_id as string;

    const auth = await authorize(clientId, CLAUDE_CALLBACK);
    expect(auth.clientName).toBe('Claude');
    expect(new URL(auth.redirectUrl as string).origin).toBe('https://claude.ai');

    const t = await token({ grant_type: 'authorization_code', code: auth.code as string, client_id: clientId, redirect_uri: CLAUDE_CALLBACK, code_verifier: VERIFIER });
    expect(t.status).toBe(200);
    const me = await fetch(`${ctx.baseUrl}/api/me`, { headers: { authorization: `Bearer ${t.body.access_token}` } });
    expect(((await me.json()) as { uid: string; clientId: string })).toMatchObject({ uid: 'alice-uid', clientId });

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token as string, client_id: clientId });
    expect(refreshed.status).toBe(200);
  });

  it('accepts Claude Code style loopback redirects on any port', async () => {
    const reg = await register({ redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'] });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const auth = await authorize(clientId, 'http://127.0.0.1:53682/callback');
    expect(auth.code).toBeTruthy();
    expect(auth.clientName).toBe('An app on your computer (such as Claude Code)');
    const t = await token({ grant_type: 'authorization_code', code: auth.code as string, client_id: clientId, code_verifier: VERIFIER });
    expect(t.status).toBe(200);
    // A different path is still refused.
    expect((await authorize(clientId, 'http://127.0.0.1:53682/other')).status).toBe(400);
  });

  it('refuses redirect URIs other than Claude callbacks and loopback', async () => {
    for (const uri of ['https://evil.example/callback', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/cb']) {
      const reg = await register({ redirect_uris: [uri] });
      expect(reg.status).toBe(400);
      expect(reg.body.error).toBe('invalid_redirect_uri');
    }
    expect((await register({})).status).toBe(400);
    expect((await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'private_key_jwt' })).body.error).toBe('invalid_client_metadata');
  });

  it('requires PKCE: no challenge at authorize, or no verifier at the token step, fails', async () => {
    const clientId = (await register({ redirect_uris: [CLAUDE_CALLBACK] })).body.client_id as string;
    const noPkce = await authorize(clientId, CLAUDE_CALLBACK, false);
    expect(noPkce.status).toBe(302);
    expect(noPkce.location.origin).toBe('https://claude.ai');
    expect(noPkce.location.searchParams.get('error')).toBe('invalid_request');

    const auth = await authorize(clientId, CLAUDE_CALLBACK);
    const t = await token({ grant_type: 'authorization_code', code: auth.code as string, client_id: clientId });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('invalid_grant');
  });

  it('does not let one registered client use another client\'s code or redirect', async () => {
    const a = (await register({ redirect_uris: [CLAUDE_CALLBACK] })).body.client_id as string;
    const b = (await register({ redirect_uris: ['http://localhost/callback'] })).body.client_id as string;
    expect((await authorize(b, CLAUDE_CALLBACK)).status).toBe(400);
    const auth = await authorize(a, CLAUDE_CALLBACK);
    const t = await token({ grant_type: 'authorization_code', code: auth.code as string, client_id: b, code_verifier: VERIFIER });
    expect(t.status).toBe(400);
  });

  it('issues a secret to clients that ask for one, and checks it', async () => {
    const reg = await register({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: 'client_secret_post' });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const secret = reg.body.client_secret as string;
    expect(secret).toBeTruthy();
    expect(JSON.stringify([...ctx.store.clients.values()])).not.toContain(secret); // only the hash is stored

    const auth1 = await authorize(clientId, CLAUDE_CALLBACK);
    expect((await token({ grant_type: 'authorization_code', code: auth1.code as string, client_id: clientId, code_verifier: VERIFIER })).status).toBe(401);
    const auth2 = await authorize(clientId, CLAUDE_CALLBACK);
    const ok = await token({ grant_type: 'authorization_code', code: auth2.code as string, client_id: clientId, client_secret: secret, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
  });

  it('can be turned off, leaving the static client working', async () => {
    await ctx.close();
    ctx = await startTestServer({ dynamicRegistration: false });
    const meta = (await (await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
    expect((await register({ redirect_uris: [CLAUDE_CALLBACK] })).status).toBe(404);
  });

  it('does not treat an unknown dyn_ client as registered', async () => {
    expect((await authorize('dyn_doesnotexist', CLAUDE_CALLBACK)).status).toBe(400);
    expect((await token({ grant_type: 'authorization_code', code: 'x', client_id: 'dyn_doesnotexist' })).status).toBe(401);
  });
});

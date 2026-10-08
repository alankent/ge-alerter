import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, CLIENT_SECRET, ID_TOKEN, OUTSIDER_ID_TOKEN, REDIRECT_URI, WEB_URL, obtainTokens, startTestServer, type TestContext } from './helpers.js';
import { isAllowedUser } from '../src/access.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await startTestServer();
});
afterEach(() => ctx.close());

describe('OAuth metadata', () => {
  it('publishes authorization server and protected resource metadata', async () => {
    const as = await (await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(as.authorization_endpoint).toBe(`${ctx.baseUrl}/oauth/authorize`);
    expect(as.token_endpoint).toBe(`${ctx.baseUrl}/oauth/token`);
    expect(as.code_challenge_methods_supported).toContain('S256');
    const pr = await (await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${ctx.baseUrl}/mcp`);
    expect(pr.authorization_servers).toEqual([ctx.baseUrl]);
  });
});

describe('authorization code flow', () => {
  it('redirects to the PWA consent page and issues tokens', async () => {
    const { status, body, consent } = await obtainTokens(ctx);
    expect(consent.origin).toBe(WEB_URL);
    expect(consent.pathname).toBe('/connect');
    expect(status).toBe(200);
    expect(body.token_type).toBe('Bearer');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.expires_in).toBe(3600);
  });

  it('preserves state and supports PKCE S256', async () => {
    const { status, body } = await obtainTokens(ctx, { pkce: true, scope: 'notifications' });
    expect(status).toBe(200);
    expect(body.scope).toBe('notifications');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const authorize = new URL('/oauth/authorize', ctx.baseUrl);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: 'not-the-right-challenge',
      code_challenge_method: 'S256',
    }).toString();
    const r1 = await fetch(authorize, { redirect: 'manual' });
    const requestId = new URL(r1.headers.get('location') as string).searchParams.get('request');
    const r2 = await fetch(`${ctx.baseUrl}/oauth/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}` },
      body: JSON.stringify({ request: requestId, approve: true }),
    });
    const code = new URL(((await r2.json()) as { redirectUrl: string }).redirectUrl).searchParams.get('code') as string;
    const r3 = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: 'wrong' }),
    });
    expect(r3.status).toBe(400);
    expect((await r3.json()).error).toBe('invalid_grant');
  });

  it('shows an error page for an unknown client or unregistered redirect', async () => {
    const bad = await fetch(`${ctx.baseUrl}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`, { redirect: 'manual' });
    expect(bad.status).toBe(400);
    const badRedirect = await fetch(
      `${ctx.baseUrl}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`,
      { redirect: 'manual' },
    );
    expect(badRedirect.status).toBe(400);
  });

  it('describes a pending request to the consent page and returns access_denied on decline', async () => {
    const authorize = `${ctx.baseUrl}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s1`;
    const r1 = await fetch(authorize, { redirect: 'manual' });
    const requestId = new URL(r1.headers.get('location') as string).searchParams.get('request') as string;
    const info = await (await fetch(`${ctx.baseUrl}/oauth/request/${requestId}`)).json();
    expect(info.clientId).toBe(CLIENT_ID);
    expect(info.clientName).toBe('Gemini Enterprise');

    const r2 = await fetch(`${ctx.baseUrl}/oauth/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}` },
      body: JSON.stringify({ request: requestId, approve: false }),
    });
    const url = new URL(((await r2.json()) as { redirectUrl: string }).redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT_URI);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('s1');
    // Request is consumed.
    expect((await fetch(`${ctx.baseUrl}/oauth/request/${requestId}`)).status).toBe(404);
  });

  it('requires a valid Firebase ID token to approve', async () => {
    const r = await fetch(`${ctx.baseUrl}/oauth/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bogus' },
      body: JSON.stringify({ request: 'x', approve: true }),
    });
    expect(r.status).toBe(401);
  });
});

describe('consent page requester name', () => {
  it('names the app from its redirect URI', async () => {
    const { requesterName } = await import('../src/oauth.js');
    expect(requesterName('https://vertexaisearch.cloud.google.com/oauth-redirect', 'x')).toBe('Gemini Enterprise');
    expect(requesterName('https://claude.ai/api/mcp/auth_callback', 'x')).toBe('Claude');
    expect(requesterName('https://claude.com/api/mcp/auth_callback', 'x')).toBe('Claude');
    expect(requesterName('http://localhost:8765/callback', 'x')).toBe('Claude Code');
    expect(requesterName('https://other.example/cb', 'Fallback')).toBe('Fallback');
  });
});

describe('token endpoint', () => {
  it('rejects bad client credentials and accepts HTTP Basic', async () => {
    const bad = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x', client_id: CLIENT_ID, client_secret: 'wrong' }),
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe('invalid_client');

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_grant');
  });

  it('refreshes an access token and rejects a reused code', async () => {
    const first = await obtainTokens(ctx);
    const r = await fetch(`${ctx.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token as string, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    expect(r.status).toBe(200);
    const refreshed = (await r.json()) as Record<string, unknown>;
    expect(refreshed.access_token).not.toBe(first.body.access_token);
    expect(refreshed.refresh_token).toBe(first.body.refresh_token);

    const me = await fetch(`${ctx.baseUrl}/api/me`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect((await me.json()).uid).toBe('alice-uid');
  });

  it('rejects expired access tokens with a bearer challenge', async () => {
    const { body } = await obtainTokens(ctx);
    const { sha256 } = await import('../src/crypto.js');
    const rec = ctx.store.accessTokens.get(sha256(body.access_token as string));
    if (rec) rec.exp = Date.now() - 1;
    const r = await fetch(`${ctx.baseUrl}/api/me`, { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

describe('allowed email domains', () => {
  it('only lets accounts from allowed domains approve a connection', async () => {
    await ctx.close();
    ctx = await startTestServer({ allowedEmailDomains: ['example.com'] });
    const start = async () => {
      const r = await fetch(`${ctx.baseUrl}/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`, { redirect: 'manual' });
      return new URL(r.headers.get('location') as string).searchParams.get('request') as string;
    };
    const decide = (token: string, request: string) =>
      fetch(`${ctx.baseUrl}/oauth/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ request, approve: true }),
      });

    const outsider = await decide(OUTSIDER_ID_TOKEN, await start());
    expect(outsider.status).toBe(403);
    expect((await outsider.json()).error_description).toContain('@example.com');

    const insider = await decide(ID_TOKEN, await start());
    expect(insider.status).toBe(200);
  });

  it('checks domain, verification and case', () => {
    expect(isAllowedUser({ uid: 'u', email: 'a@IMDigital.com', emailVerified: true }, ['imdigital.com'])).toBe(true);
    expect(isAllowedUser({ uid: 'u', email: 'a@imdigital.com', emailVerified: false }, ['imdigital.com'])).toBe(false);
    expect(isAllowedUser({ uid: 'u', email: 'a@imdigital.com.evil.test', emailVerified: true }, ['imdigital.com'])).toBe(false);
    expect(isAllowedUser({ uid: 'u', email: 'a@sub.imdigital.com', emailVerified: true }, ['imdigital.com'])).toBe(false);
    expect(isAllowedUser({ uid: 'u' }, [])).toBe(true);
  });
});

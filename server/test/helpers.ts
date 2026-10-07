import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { MemoryIdentity, MemoryPusher, MemoryStore } from '../src/store/memory.js';

export interface TestContext {
  config: Config;
  store: MemoryStore;
  pusher: MemoryPusher;
  baseUrl: string;
  close(): Promise<void>;
}

export const CLIENT_ID = 'test-client';
export const CLIENT_SECRET = 'test-secret';
export const REDIRECT_URI = 'https://vertexaisearch.cloud.google.com/oauth-redirect';
export const WEB_URL = 'https://alerter.example.test';
export const ID_TOKEN = 'id-token-for-alice';
export const ALICE = { uid: 'alice-uid', email: 'alice@example.com', emailVerified: true };
export const OUTSIDER_ID_TOKEN = 'id-token-for-mallory';
export const MALLORY = { uid: 'mallory-uid', email: 'mallory@elsewhere.test', emailVerified: true };

export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestContext> {
  const store = new MemoryStore();
  const pusher = new MemoryPusher();
  const identity = new MemoryIdentity({ [ID_TOKEN]: ALICE, [OUTSIDER_ID_TOKEN]: MALLORY });
  const base = loadConfig({
    STORE: 'memory',
    WEB_URL,
    OAUTH_CLIENT_ID: CLIENT_ID,
    OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    OAUTH_REDIRECT_URIS: REDIRECT_URI,
  } as NodeJS.ProcessEnv);
  const config: Config = { ...base, port: 0, ...overrides };
  const app = createApp({ config, store, pusher, identity });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  config.publicUrl = baseUrl;
  return {
    config,
    store,
    pusher,
    baseUrl,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** Drives the full authorization-code flow and returns the token response. */
export async function obtainTokens(ctx: TestContext, opts: { pkce?: boolean; scope?: string } = {}) {
  const verifier = 'a-very-long-pkce-verifier-string-with-enough-entropy-0123456789';
  const { createHash } = await import('node:crypto');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorize = new URL('/oauth/authorize', ctx.baseUrl);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', CLIENT_ID);
  authorize.searchParams.set('redirect_uri', REDIRECT_URI);
  authorize.searchParams.set('state', 'xyz');
  if (opts.scope) authorize.searchParams.set('scope', opts.scope);
  if (opts.pkce) {
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
  }
  const r1 = await fetch(authorize, { redirect: 'manual' });
  if (r1.status !== 302) throw new Error(`authorize returned ${r1.status}`);
  const consent = new URL(r1.headers.get('location') as string);
  const requestId = consent.searchParams.get('request') as string;

  const r2 = await fetch(`${ctx.baseUrl}/oauth/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ID_TOKEN}`, origin: WEB_URL },
    body: JSON.stringify({ request: requestId, approve: true }),
  });
  const decision = (await r2.json()) as { redirectUrl: string };
  const code = new URL(decision.redirectUrl).searchParams.get('code') as string;

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  if (opts.pkce) form.set('code_verifier', verifier);
  const r3 = await fetch(`${ctx.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return { status: r3.status, body: (await r3.json()) as Record<string, unknown>, consent, requestId };
}

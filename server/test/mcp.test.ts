import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { obtainTokens, startTestServer, type TestContext } from './helpers.js';

let ctx: TestContext;
let accessToken: string;

beforeEach(async () => {
  ctx = await startTestServer();
  accessToken = (await obtainTokens(ctx)).body.access_token as string;
});
afterEach(() => ctx.close());

async function connect(token = accessToken) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', ctx.baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP endpoint', () => {
  it('rejects unauthenticated requests with a 401 challenge', async () => {
    const r = await fetch(`${ctx.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  it('lists the notification tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_notifications', 'mark_notification_read', 'send_notification']);
    const send = tools.find((t) => t.name === 'send_notification');
    expect(send?.inputSchema.required).toEqual(['title']);
    await client.close();
  });

  it('send_notification stores the alert and pushes to every device', async () => {
    ctx.store.devices.set('alice-uid', [
      { key: 'd1', token: 'tok-1' },
      { key: 'd2', token: 'tok-dead' },
    ]);
    ctx.pusher.invalid.add('tok-dead');
    ctx.store.settings.set('alice-uid', { defaultUrl: 'https://geminienterprise.example/inbox' });

    const client = await connect();
    const result = await client.callTool({
      name: 'send_notification',
      arguments: {
        title: 'Weekly report ready',
        body: 'The competitor digest workflow finished.',
        actions: [{ title: 'Open report', url: 'https://docs.example/report' }],
        tags: ['digest'],
        data: { runId: 'run-42' },
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { id: string; delivered: number; devices: number };
    expect(structured.devices).toBe(2);
    expect(structured.delivered).toBe(1);

    const stored = ctx.store.notifications.get('alice-uid')?.[0];
    expect(stored?.title).toBe('Weekly report ready');
    expect(stored?.url).toBe('https://geminienterprise.example/inbox');
    expect(stored?.source).toBe('mcp');
    expect(stored?.clientId).toBe('test-client');
    expect(stored?.read).toBe(false);

    expect(ctx.pusher.sent).toHaveLength(1);
    const push = ctx.pusher.sent[0];
    expect(push.tokens).toEqual(['tok-1', 'tok-dead']);
    expect(push.priority).toBe('high');
    expect(push.data.title).toBe('Weekly report ready');
    expect(JSON.parse(push.data.actions)).toEqual([{ title: 'Open report', url: 'https://docs.example/report' }]);
    expect(push.data.ackUrl).toContain(`/api/notifications/${structured.id}/ack?`);
    // Dead token was pruned.
    expect(ctx.store.devices.get('alice-uid')?.map((d) => d.key)).toEqual(['d1']);

    // The ack link from the push marks it read without any sign-in.
    const ack = await fetch(push.data.ackUrl, { method: 'POST' });
    expect(ack.status).toBe(204);
    expect(stored?.read).toBe(true);
    // A tampered link is refused.
    const tampered = await fetch(push.data.ackUrl.replace(/token=.*$/, 'token=bad'), { method: 'POST' });
    expect(tampered.status).toBe(403);
    await client.close();
  });

  it('tells the agent where to send the user when no device has notifications on', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'send_notification', arguments: { title: 'Nobody listening' } });
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toContain(ctx.config.webUrl);
    expect(text).toContain('not turned on notifications');
    await client.close();
  });

  it('validates tool input', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'send_notification', arguments: { title: '', url: 'ftp://nope' } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('list_notifications and mark_notification_read work per user', async () => {
    const client = await connect();
    await client.callTool({ name: 'send_notification', arguments: { title: 'One' } });
    await client.callTool({ name: 'send_notification', arguments: { title: 'Two' } });
    const list = await client.callTool({ name: 'list_notifications', arguments: { limit: 5 } });
    const items = (list.structuredContent as { notifications: Array<{ id: string; title: string; read: boolean }> }).notifications;
    expect(items.map((n) => n.title)).toEqual(['Two', 'One']);

    const mark = await client.callTool({ name: 'mark_notification_read', arguments: { id: items[1].id } });
    expect(mark.isError).toBeFalsy();
    const unread = await client.callTool({ name: 'list_notifications', arguments: { unreadOnly: true } });
    expect((unread.structuredContent as { notifications: unknown[] }).notifications).toHaveLength(1);

    const missing = await client.callTool({ name: 'mark_notification_read', arguments: { id: 'nope' } });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});

describe('REST endpoint', () => {
  it('POST /api/notify behaves like the tool', async () => {
    ctx.store.devices.set('alice-uid', [{ key: 'd1', token: 'tok-1' }]);
    const r = await fetch(`${ctx.baseUrl}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ title: 'From a workflow HTTP step', priority: 'normal' }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; delivered: number };
    expect(body.delivered).toBe(1);
    expect(ctx.pusher.sent[0].priority).toBe('normal');
    expect(ctx.store.notifications.get('alice-uid')?.[0].source).toBe('api');

    const bad = await fetch(`${ctx.baseUrl}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ body: 'no title' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('test push from the PWA', () => {
  it('pushes only to the caller\'s own device and needs a Firebase ID token', async () => {
    const { ID_TOKEN, OUTSIDER_ID_TOKEN } = await import('./helpers.js');
    ctx.store.devices.set('alice-uid', [
      { key: 'd1', token: 'tok-1' },
      { key: 'd2', token: 'tok-2' },
    ]);
    const post = (token: string | null, device: string) =>
      fetch(new URL('/api/test-push', ctx.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ device }),
      });

    expect((await post(null, 'd1')).status).toBe(401);
    expect((await post('not-a-token', 'd1')).status).toBe(401);
    expect((await post(OUTSIDER_ID_TOKEN, 'd1')).status).toBe(404); // Mallory has no such device.
    expect((await post(ID_TOKEN, 'nope')).status).toBe(404);

    const ok = await post(ID_TOKEN, 'd2');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ delivered: 1 });
    expect(ctx.pusher.sent).toHaveLength(1);
    expect(ctx.pusher.sent[0].tokens).toEqual(['tok-2']);
    expect(ctx.store.notifications.get('alice-uid') ?? []).toHaveLength(0); // not stored in the inbox

    ctx.pusher.invalid.add('tok-2');
    expect((await post(ID_TOKEN, 'd2')).status).toBe(410);
    expect(ctx.store.devices.get('alice-uid')?.map((d) => d.key)).toEqual(['d1']);
  });

  it('refuses accounts outside the allowed domains', async () => {
    await ctx.close();
    ctx = await startTestServer({ allowedEmailDomains: ['example.com'] });
    const { OUTSIDER_ID_TOKEN } = await import('./helpers.js');
    const r = await fetch(new URL('/api/test-push', ctx.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OUTSIDER_ID_TOKEN}` },
      body: JSON.stringify({ device: 'd1' }),
    });
    expect(r.status).toBe(403);
  });
});

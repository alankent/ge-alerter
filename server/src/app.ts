import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allowedDomainsText, isAllowedUser } from './access.js';
import { bearerAuth, userIdFrom, type AuthedRequest } from './bearer.js';
import type { Config } from './config.js';
import { ackToken, safeEqual } from './crypto.js';
import { createMcpServer } from './mcp.js';
import { Notifier, notificationInputSchema } from './notify.js';
import { createOAuthRouter } from './oauth.js';
import type { Identity, Pusher, Store, VerifiedUser } from './store/types.js';

export interface AppDeps {
  config: Config;
  store: Store;
  pusher: Pusher;
  identity: Identity;
}

/** CORS for the PWA origin only. The MCP and OAuth token endpoints are server-to-server. */
function cors(webUrl: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origin === webUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

export function createApp({ config, store, pusher, identity }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(cors(config.webUrl));

  const notifier = new Notifier(store, pusher, config);
  const requireBearer = bearerAuth(config, store);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/', (_req, res) => {
    res.type('text').send(`Agent Notifications MCP server\n\nMCP endpoint: ${config.publicUrl}/mcp\nApp: ${config.webUrl}\n`);
  });

  app.use(createOAuthRouter({ config, store, identity }));

  /** Stateless Streamable HTTP: new server + transport per request. */
  app.post('/mcp', requireBearer, async (req: AuthedRequest, res) => {
    const server = createMcpServer(notifier, store, config.webUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  /**
   * Plain REST equivalent of the send_notification tool, for callers that
   * are not MCP clients (a Workflow Builder HTTP step, curl, a Cloud Function).
   * Same bearer token as the MCP endpoint.
   */
  app.post('/api/notify', requireBearer, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = notificationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      }
      const outcome = await notifier.send(userIdFrom(req.auth), parsed.data, 'api', req.auth?.clientId);
      res.status(201).json({ id: outcome.notification.id, delivered: outcome.delivered, devices: outcome.devices, removedLinks: outcome.removedLinks });
    } catch (err) {
      next(err);
    }
  });

  /**
   * "Send test" in the PWA: pushes a test alert to one of the signed-in user's own devices, through FCM like a
   * real alert, so it proves the whole path. Not stored in the inbox. Authenticated with the PWA's Firebase ID token.
   */
  app.post('/api/test-push', async (req, res, next) => {
    try {
      const header = req.headers.authorization ?? '';
      if (!header.toLowerCase().startsWith('bearer ')) return res.status(401).json({ error: 'unauthorized' });
      let user: VerifiedUser;
      try {
        user = await identity.verifyIdToken(header.slice(7).trim());
      } catch {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (!isAllowedUser(user, config.allowedEmailDomains)) {
        return res.status(403).json({ error: 'forbidden', error_description: `Only ${allowedDomainsText(config.allowedEmailDomains)} accounts can use this app.` });
      }
      const key = typeof req.body?.device === 'string' ? req.body.device : '';
      const device = (await store.listDevices(user.uid)).find((d) => d.key === key);
      if (!device) {
        return res.status(404).json({ error: 'not_found', error_description: 'Notifications are not turned on for this device.' });
      }
      const now = Date.now();
      const result = await pusher.send(
        [device.token],
        {
          id: `test-${now}`,
          title: 'Notifications are working',
          body: 'This is a test. Notifications from your agents and workflows will appear like this.',
          url: config.webUrl,
          actions: '[]',
          tags: '[]',
          createdAt: String(now),
          priority: 'high',
          ackUrl: '',
          inboxUrl: config.webUrl,
        },
        'high',
      );
      if (result.invalidTokens.includes(device.token)) {
        await store.removeDevice(user.uid, device.key);
        return res.status(410).json({ error: 'gone', error_description: 'This device stopped accepting notifications. Turn them on again.' });
      }
      res.json({ delivered: result.successCount });
    } catch (err) {
      next(err);
    }
  });

  /** Who am I: handy for checking a token from Gemini Enterprise's side. */
  app.get('/api/me', requireBearer, (req: AuthedRequest, res) => {
    res.json({ uid: userIdFrom(req.auth), clientId: req.auth?.clientId, scopes: req.auth?.scopes });
  });

  /**
   * Acknowledgement link used by the "Mark done" notification button. The
   * service worker cannot sign in, so the link carries an HMAC instead.
   */
  const ack = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const uid = typeof req.query.uid === 'string' ? req.query.uid : '';
      if (!uid || !token || !safeEqual(token, ackToken(config.ackSecret, uid, id))) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const ok = await store.markRead(uid, id);
      if (!ok) return res.status(404).json({ error: 'not_found' });
      if (req.method === 'GET') {
        return res.type('html').send('<!doctype html><meta charset="utf-8"><title>Done</title><body style="font-family:system-ui;margin:3rem">Marked as read. You can close this tab.</body>');
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };
  app.post('/api/notifications/:id/ack', ack);
  app.get('/api/notifications/:id/ack', ack);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

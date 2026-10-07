import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userIdFrom } from './bearer.js';
import { notificationInputShape, type Notifier } from './notify.js';
import type { Store } from './store/types.js';

export const SERVER_INFO = { name: 'ge-alerter', version: '0.1.0' };

/**
 * Builds the MCP server that Gemini Enterprise talks to. A fresh instance is
 * created per HTTP request (stateless Streamable HTTP), so this must be cheap.
 */
export function createMcpServer(notifier: Notifier, store: Store): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Use send_notification to alert the user on their desktop when a scheduled agent or workflow finishes, ' +
      'needs attention, or finds something worth reporting. Keep titles short and put details in body or data. ' +
      'Include a url to the conversation or result when you have one.',
  });

  server.registerTool(
    'send_notification',
    {
      title: 'Send desktop notification',
      description:
        'Sends a desktop notification to the signed-in user and records it in their alert inbox. ' +
        'Call this when a scheduled run completes, fails, or needs human input.',
      inputSchema: notificationInputShape,
      outputSchema: {
        id: z.string(),
        delivered: z.number().int().describe('Devices the push was delivered to.'),
        devices: z.number().int().describe('Devices registered for the user.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      const uid = userIdFrom(extra.authInfo);
      const outcome = await notifier.send(uid, args, 'mcp', extra.authInfo?.clientId);
      const summary =
        outcome.devices === 0
          ? `Notification saved to the inbox, but the user has no devices registered for push. Ask them to enable notifications in the GE Alerter app.`
          : `Notification sent to ${outcome.delivered} of ${outcome.devices} device(s) and saved to the inbox.`;
      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { id: outcome.notification.id, delivered: outcome.delivered, devices: outcome.devices },
      };
    },
  );

  server.registerTool(
    'list_notifications',
    {
      title: 'List recent notifications',
      description: 'Lists the most recent notifications in the user\'s alert inbox, newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('How many to return (default 10).'),
        unreadOnly: z.boolean().optional().describe('Only return notifications the user has not read.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, unreadOnly }, extra) => {
      const uid = userIdFrom(extra.authInfo);
      let items = await store.listNotifications(uid, limit ?? 10);
      if (unreadOnly) items = items.filter((n) => !n.read);
      const lines = items.map(
        (n) => `- [${n.read ? 'read' : 'unread'}] ${new Date(n.createdAt).toISOString()} ${n.id}: ${n.title}${n.body ? ` — ${n.body}` : ''}`,
      );
      return {
        content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No notifications.' }],
        structuredContent: { notifications: items },
      };
    },
  );

  server.registerTool(
    'mark_notification_read',
    {
      title: 'Mark notification read',
      description: 'Marks a notification in the user\'s inbox as read.',
      inputSchema: { id: z.string().min(1).describe('Notification id returned by send_notification or list_notifications.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }, extra) => {
      const uid = userIdFrom(extra.authInfo);
      const ok = await store.markRead(uid, id);
      return { content: [{ type: 'text', text: ok ? `Marked ${id} as read.` : `No notification with id ${id}.` }], isError: !ok };
    },
  );

  return server;
}

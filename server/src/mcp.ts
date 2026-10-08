import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { userIdFrom } from './bearer.js';
import { notificationInputShape, type Notifier } from './notify.js';
import { PLATFORMS, setupInstructions } from './setupGuide.js';
import type { Store } from './store/types.js';

/** name is the stable id; title is what MCP clients show people. */
export const SERVER_INFO = { name: 'ge-alerter', title: 'Agent Notifications', version: '0.1.0' };

/**
 * Builds the MCP server that Gemini Enterprise talks to. A fresh instance is
 * created per HTTP request (stateless Streamable HTTP), so this must be cheap.
 */
export function createMcpServer(notifier: Notifier, store: Store, setupUrl: string): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Use send_notification to alert the user on their desktop when a scheduled agent or workflow finishes, ' +
      'needs attention, or finds something worth reporting. Keep titles short and put details in body or data. ' +
      'Include a url to the conversation or result when you have one. ' +
      'If the user asks how to get notifications on a device, or send_notification reports no devices, call ' +
      `get_setup_instructions and relay the steps, or send them to ${setupUrl}/install`,
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
          ? `Notification saved to the inbox, but the user has not turned on notifications on any device, so nothing popped up. ` +
            `Tell the user to open ${setupUrl}/install on each computer, phone or tablet where they want notifications and follow the steps there, ` +
            'or call get_setup_instructions to give them the steps.'
          : outcome.delivered === 0
            ? `Notification saved to the inbox, but none of the user's ${outcome.devices} device(s) accepted it. ` +
              `Suggest they open ${setupUrl} and use Send test to check their setup; ${setupUrl}/install has help for each device.`
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

  server.registerTool(
    'get_setup_instructions',
    {
      title: 'Get device setup instructions',
      description:
        'Returns step-by-step instructions for setting up a device to receive these notifications (iPhone and iPad via ' +
        'Safari and the Home Screen, Windows, Mac, Android, other). Call it when the user asks how to get notifications, ' +
        'or when send_notification reports that no device received the notification, and relay the steps to the user.',
      inputSchema: {
        platform: z.enum(PLATFORMS).optional().describe('The device the user has, if known. Omit to get every platform.'),
      },
      outputSchema: {
        setupUrl: z.string().describe('Open on the device to sign in and turn on notifications.'),
        instructionsUrl: z.string().describe('Step-by-step instructions with pictures for every kind of device.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ platform }) => ({
      content: [{ type: 'text', text: setupInstructions(setupUrl, platform) }],
      structuredContent: { setupUrl, instructionsUrl: `${setupUrl}/install` },
    }),
  );

  return server;
}

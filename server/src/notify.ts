import { z } from 'zod';
import type { Config } from './config.js';
import { ackToken } from './crypto.js';
import type { NotificationInput, NotificationRecord, Pusher, Store } from './store/types.js';
import { isAllowedLink } from './links.js';

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://');

/** Schema shared by the MCP tool and the REST endpoint. */
export const notificationInputShape = {
  title: z.string().trim().min(1).max(120).describe('Short headline shown in the desktop notification.'),
  body: z.string().trim().max(1000).optional().describe('Longer text shown under the title. Plain text, a few sentences at most.'),
  url: httpUrl
    .optional()
    .describe('Opened when the user clicks the notification. Defaults to the link the user configured (for example their Gemini Enterprise inbox).'),
  actions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(24).describe('Button label.'),
        url: httpUrl.describe('Opened when the button is clicked.'),
      }),
    )
    .max(2)
    .optional()
    .describe('Up to two buttons shown on the notification. Chrome shows at most two.'),
  priority: z
    .enum(['normal', 'high'])
    .optional()
    .describe('"high" wakes the device immediately; use "normal" for routine completions.'),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).optional().describe('Labels for filtering in the inbox, for example the workflow name.'),
  data: z
    .record(z.string(), z.string().max(2000))
    .optional()
    .describe('Extra key/value details shown in the inbox entry, such as a run id or summary of results.'),
};

export const notificationInputSchema = z.object(notificationInputShape);

export interface SendOutcome {
  notification: NotificationRecord;
  delivered: number;
  devices: number;
  /** Links the agent supplied that are not on the allow-list and were dropped. */
  removedLinks: string[];
}

export class Notifier {
  constructor(
    private store: Store,
    private pusher: Pusher,
    private config: Config,
  ) {}

  ackUrl(uid: string, id: string): string {
    return `${this.config.publicUrl}/api/notifications/${encodeURIComponent(id)}/ack?uid=${encodeURIComponent(uid)}&token=${ackToken(this.config.ackSecret, uid, id)}`;
  }

  async send(uid: string, input: NotificationInput, source: string, clientId?: string): Promise<SendOutcome> {
    const settings = await this.store.getUserSettings(uid);
    // Only agent-supplied links are checked; the user's own default link is theirs to choose.
    const removedLinks: string[] = [];
    const allowed = (link: string) => {
      const ok = isAllowedLink(link, this.config.allowedLinks, this.config.webUrl);
      if (!ok) removedLinks.push(link);
      return ok;
    };
    const url = input.url && allowed(input.url) ? input.url : undefined;
    const actions = input.actions?.filter((a) => allowed(a.url));
    const record: Omit<NotificationRecord, 'id'> = {
      ...input,
      ...(input.actions ? { actions } : {}),
      url: url ?? settings.defaultUrl,
      createdAt: Date.now(),
      read: false,
      source,
      clientId,
    };
    const id = await this.store.addNotification(uid, record);
    const notification: NotificationRecord = { ...record, id };

    const devices = await this.store.listDevices(uid);
    let delivered = 0;
    if (devices.length > 0) {
      const data: Record<string, string> = {
        id,
        title: notification.title,
        body: notification.body ?? '',
        url: notification.url ?? '',
        actions: JSON.stringify(notification.actions ?? []),
        tags: JSON.stringify(notification.tags ?? []),
        createdAt: String(notification.createdAt),
        priority: notification.priority ?? 'high',
        ackUrl: this.ackUrl(uid, id),
        inboxUrl: `${this.config.webUrl}/?n=${encodeURIComponent(id)}`,
      };
      const result = await this.pusher.send(
        devices.map((d) => d.token),
        data,
        notification.priority ?? 'high',
      );
      delivered = result.successCount;
      for (const dead of result.invalidTokens) {
        const device = devices.find((d) => d.token === dead);
        if (device) await this.store.removeDevice(uid, device.key);
      }
    }
    return { notification, delivered, devices: devices.length, removedLinks };
  }
}

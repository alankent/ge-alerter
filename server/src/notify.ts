import { z } from 'zod';
import type { Config } from './config.js';
import { ackToken } from './crypto.js';
import type { NotificationInput, NotificationRecord, Pusher, Store } from './store/types.js';
import { isAllowedLink } from './links.js';

/** Limits the stored notification is fitted to. Agents are not refused for exceeding them; see normalizeNotification. */
export const LIMITS = { title: 120, body: 4000, pushBody: 500, actions: 2, actionTitle: 24, tags: 10, tag: 32, dataKeys: 30, dataValue: 2000 };

const text = z.string().nullish();

/**
 * Schema shared by the MCP tool and the REST endpoint. It is deliberately forgiving: a scheduled run that is refused
 * for a long title or an empty link loses its notification, so anything reasonable is accepted and then fitted by
 * normalizeNotification, which reports what it changed.
 */
export const notificationInputShape = {
  title: text.describe(`Short headline shown in the notification. About 80 characters is ideal; longer titles are shortened to ${LIMITS.title}.`),
  body: text.describe(
    `Details shown under the title. Plain text. The pop-up shows the first few lines; up to ${LIMITS.body} characters are kept in the notification history.`,
  ),
  url: text.describe('https link opened when the user clicks the notification, such as the conversation or result. Defaults to the link the user configured.'),
  actions: z
    .array(z.object({ title: text.describe('Button label, a few words.'), url: text.describe('https link the button opens.') }))
    .nullish()
    .describe(`Up to ${LIMITS.actions} buttons shown on the notification; extra ones are ignored.`),
  priority: text.describe('"high" for things that need the user\'s attention; otherwise "normal".'),
  tags: z.array(z.string()).nullish().describe('Short labels for filtering in the history, for example the workflow name.'),
  data: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe('Extra key/value details shown in the history entry, such as a run id or a summary of results.'),
};

export const notificationInputSchema = z.object(notificationInputShape);
export type RawNotificationInput = z.infer<typeof notificationInputSchema>;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…';
}

function httpUrl(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Fits whatever the agent sent into a notification and lists what had to change, so the agent can be told. */
export function normalizeNotification(raw: RawNotificationInput): { input: NotificationInput; adjustments: string[] } {
  const adjustments: string[] = [];
  const body = raw.body?.trim() || undefined;
  let title = raw.title?.trim().replace(/\s+/g, ' ') || '';
  if (!title) {
    title = body ? body.split('\n')[0] : 'Notification from your agent';
    adjustments.push('no title was given, so one was made from the body');
  }
  if (title.length > LIMITS.title) adjustments.push(`the title was shortened to ${LIMITS.title} characters`);
  const input: NotificationInput = { title: clip(title, LIMITS.title) };

  if (body) {
    if (body.length > LIMITS.body) adjustments.push(`the body was shortened to ${LIMITS.body} characters`);
    input.body = clip(body, LIMITS.body);
  }

  if (raw.url?.trim()) {
    const url = httpUrl(raw.url);
    if (url) input.url = url;
    else adjustments.push(`the link "${clip(raw.url.trim(), 80)}" is not a web address and was ignored`);
  }

  const actions = (raw.actions ?? [])
    .map((a) => ({ title: a.title?.trim() ?? '', url: httpUrl(a.url) }))
    .filter((a): a is { title: string; url: string } => Boolean(a.title && a.url));
  if (actions.length < (raw.actions?.length ?? 0)) adjustments.push('buttons without a label or a valid web address were ignored');
  if (actions.length > LIMITS.actions) adjustments.push(`only the first ${LIMITS.actions} buttons are shown`);
  if (actions.length) input.actions = actions.slice(0, LIMITS.actions).map((a) => ({ title: clip(a.title, LIMITS.actionTitle), url: a.url }));

  const priority = raw.priority?.trim().toLowerCase();
  if (priority) input.priority = /^(high|urgent|critical|important|asap)$/.test(priority) ? 'high' : 'normal';

  const tags = [...new Set((raw.tags ?? []).map((t) => t.trim()).filter(Boolean))];
  if (tags.length > LIMITS.tags) adjustments.push(`only the first ${LIMITS.tags} tags were kept`);
  if (tags.length) input.tags = tags.slice(0, LIMITS.tags).map((t) => clip(t, LIMITS.tag));

  const entries = Object.entries(raw.data ?? {}).filter(([k, v]) => k.trim() && v !== null && v !== undefined && v !== '');
  if (entries.length > LIMITS.dataKeys) adjustments.push(`only the first ${LIMITS.dataKeys} data entries were kept`);
  if (entries.length) {
    input.data = Object.fromEntries(
      entries.slice(0, LIMITS.dataKeys).map(([k, v]) => [clip(k.trim(), 100), clip(typeof v === 'string' ? v : JSON.stringify(v), LIMITS.dataValue)]),
    );
  }
  return { input, adjustments };
}

export interface SendOutcome {
  notification: NotificationRecord;
  delivered: number;
  devices: number;
  /** Links the agent supplied that are not on the allow-list and were dropped. */
  removedLinks: string[];
  /** Other ways the agent's input was fitted (shortened, ignored fields); empty when used as sent. */
  adjustments: string[];
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

  async send(uid: string, raw: RawNotificationInput, source: string, clientId?: string): Promise<SendOutcome> {
    const { input, adjustments } = normalizeNotification(raw);
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
        // FCM data messages are limited to 4 KB; the full body stays in the history.
        body: clip(notification.body ?? '', LIMITS.pushBody),
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
    return { notification, delivered, devices: devices.length, removedLinks, adjustments };
  }
}

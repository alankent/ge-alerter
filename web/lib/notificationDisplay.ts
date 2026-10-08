'use client';

/**
 * Builds a desktop notification from the data-only FCM payload. Mirrors the
 * logic in public/sw.js (which cannot import modules), so keep the two in sync.
 */
export interface PushData {
  id: string;
  title: string;
  body?: string;
  url?: string;
  actions?: string;
  tags?: string;
  createdAt?: string;
  priority?: string;
  ackUrl?: string;
  inboxUrl?: string;
}

/** Chrome supports `actions` and `timestamp`, which the DOM typings omit. */
export type RichNotificationOptions = NotificationOptions & { actions?: { action: string; title: string }[]; timestamp?: number };

export function buildNotificationOptions(data: PushData): RichNotificationOptions {
  let actions: { title: string; url: string }[] = [];
  try {
    actions = JSON.parse(data.actions || '[]');
  } catch {
    actions = [];
  }
  const buttons = actions.slice(0, 2).map((a, i) => ({ action: `a${i}`, title: a.title }));
  if (buttons.length < 2) buttons.push({ action: 'ack', title: 'Mark done' });
  return {
    body: data.body || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: data.id,
    data,
    actions: buttons,
    requireInteraction: data.priority === 'high',
    timestamp: data.createdAt ? Number(data.createdAt) : Date.now(),
  };
}

export async function showLocalNotification(data: PushData): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(data.title || 'Agent Notifications', buildNotificationOptions(data));
}

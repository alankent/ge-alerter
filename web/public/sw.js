/* eslint-disable no-undef */
/**
 * Service worker for GE Alerter.
 *
 * Receives data-only Firebase Cloud Messaging pushes and shows a desktop
 * notification with action buttons. The Firebase config is passed in the
 * registration URL (?config=...) so this file needs no build step.
 */
const FIREBASE_VERSION = '12.19.0';
const params = new URL(self.location.href).searchParams;
let firebaseConfig = {};
try {
  firebaseConfig = JSON.parse(params.get('config') || '{}');
} catch (_) {
  firebaseConfig = {};
}

importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`);
importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-messaging-compat.js`);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** Keep in sync with lib/notificationDisplay.ts. */
function buildNotificationOptions(data) {
  let actions = [];
  try {
    actions = JSON.parse(data.actions || '[]');
  } catch (_) {
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

if (firebaseConfig.projectId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    return self.registration.showNotification(data.title || 'Gemini Enterprise', buildNotificationOptions(data));
  });
}

function ack(data) {
  if (!data || !data.ackUrl) return Promise.resolve();
  return fetch(data.ackUrl, { method: 'POST', keepalive: true }).catch(() => undefined);
}

async function openUrl(url) {
  const target = new URL(url, self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin === target.origin && 'focus' in client) {
      await client.focus();
      if ('navigate' in client && new URL(client.url).href !== target.href) {
        try {
          await client.navigate(target.href);
        } catch (_) {
          // Cross-origin or detached client: fall through to openWindow.
          break;
        }
      }
      return;
    }
  }
  await self.clients.openWindow(target.href);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();

  if (event.action === 'ack') {
    event.waitUntil(ack(data));
    return;
  }

  let url = data.url || data.inboxUrl || '/';
  if (event.action && event.action.startsWith('a')) {
    try {
      const action = JSON.parse(data.actions || '[]')[Number(event.action.slice(1))];
      if (action && action.url) url = action.url;
    } catch (_) {
      // ignore
    }
  }
  event.waitUntil(Promise.all([ack(data), openUrl(url)]));
});

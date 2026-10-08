'use client';

import { deleteToken, getToken, onMessage, type Messaging } from 'firebase/messaging';
import { ref, remove, set } from 'firebase/database';
import type { User } from 'firebase/auth';
import { API_URL, db, firebaseConfig, messaging, VAPID_KEY } from './firebase';
import { showLocalNotification, type PushData } from './notificationDisplay';

const DEVICE_KEY_STORAGE = 'ge-alerter:deviceKey';

/** Stable id for this browser profile so re-registrations overwrite the same record. */
export function deviceKey(): string {
  let key: string | null = null;
  try {
    key = localStorage.getItem(DEVICE_KEY_STORAGE);
    if (!key) {
      key = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(DEVICE_KEY_STORAGE, key);
    }
  } catch {
    key = key ?? crypto.randomUUID().replace(/-/g, '');
  }
  return key;
}

export type PushSupport = 'unsupported' | 'denied' | 'default' | 'granted';

/**
 * True on an iPhone or iPad that is showing the site in a browser tab. Apple only grants Web Push to web apps
 * added to the Home Screen from Safari, so the fix is to install, not to switch browsers.
 */
export function needsHomeScreenInstall(): boolean {
  if (typeof window === 'undefined') return false;
  const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return apple && !standalone;
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission as PushSupport;
}

/** Registers the service worker with the Firebase config passed in the URL. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const config = encodeURIComponent(JSON.stringify(firebaseConfig));
  const reg = await navigator.serviceWorker.register(`/sw.js?config=${config}`, { scope: '/' });
  await navigator.serviceWorker.ready;
  return reg;
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  // iPads report a Mac user agent; the touch screen tells them apart.
  const apple = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const os = apple ? 'iPadOS/iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

/**
 * Asks for permission, obtains an FCM token for this browser and stores it
 * under the user's devices so the server can push to it.
 */
export async function enablePush(uid: string): Promise<{ token: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');
  const m = await messaging();
  if (!m) throw new Error('Push messaging is not supported in this browser');
  const registration = await registerServiceWorker();
  // Without a project VAPID key the Firebase SDK uses its built-in default key, which works with FCM.
  const token = await getToken(m, { ...(VAPID_KEY ? { vapidKey: VAPID_KEY } : {}), serviceWorkerRegistration: registration });
  await set(ref(db(), `users/${uid}/devices/${deviceKey()}`), {
    token,
    userAgent: navigator.userAgent,
    label: browserLabel(),
    createdAt: Date.now(),
  });
  return { token };
}

export async function disablePush(uid: string): Promise<void> {
  const m = await messaging();
  if (m) {
    try {
      await deleteToken(m);
    } catch {
      // Token may already be gone.
    }
  }
  await remove(ref(db(), `users/${uid}/devices/${deviceKey()}`));
}

/** Asks the server to push a test alert to this device through FCM, exactly like a real alert. */
export async function sendTestPush(user: User): Promise<void> {
  const r = await fetch(`${API_URL}/api/test-push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await user.getIdToken()}` },
    body: JSON.stringify({ device: deviceKey() }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `The test could not be sent (HTTP ${r.status}).`);
  }
}

/**
 * While the app is focused, FCM hands messages to the page instead of the
 * service worker. Show them as desktop notifications anyway so behaviour is
 * the same whether or not the tab is in front.
 */
export async function listenForeground(onData?: (data: PushData) => void): Promise<() => void> {
  const m: Messaging | null = await messaging();
  if (!m) return () => undefined;
  return onMessage(m, (payload) => {
    const data = (payload.data ?? {}) as unknown as PushData;
    onData?.(data);
    void showLocalNotification(data);
  });
}

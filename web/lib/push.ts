'use client';

import { deleteToken, getToken, onMessage, type Messaging } from 'firebase/messaging';
import { ref, remove, set } from 'firebase/database';
import { db, firebaseConfig, messaging, VAPID_KEY } from './firebase';
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
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

/**
 * Asks for permission, obtains an FCM token for this browser and stores it
 * under the user's devices so the server can push to it.
 */
export async function enablePush(uid: string): Promise<{ token: string }> {
  if (!VAPID_KEY) throw new Error('NEXT_PUBLIC_FIREBASE_VAPID_KEY is not set');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');
  const m = await messaging();
  if (!m) throw new Error('Push messaging is not supported in this browser');
  const registration = await registerServiceWorker();
  const token = await getToken(m, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
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

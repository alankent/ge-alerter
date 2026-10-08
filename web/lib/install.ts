'use client';

import { useEffect, useState } from 'react';

/** Chrome and Edge fire this when the app can be installed; we keep it to show our own Install button. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export interface Platform {
  /** iPhone or iPad (iPads report a Mac user agent; the touch screen tells them apart). */
  ios: boolean;
  /** Running as an installed app rather than in a browser tab. */
  standalone: boolean;
  /** On iOS, a browser other than Safari (Chrome, Firefox, Edge, the Google app...). */
  iosOtherBrowser: boolean;
  browser: 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
  os: 'ios' | 'android' | 'windows' | 'mac' | 'other';
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const iosOtherBrowser = ios && /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram/.test(ua);
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'chrome'
        : /Safari\//.test(ua)
          ? 'safari'
          : 'other';
  const os = ios ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : 'other';
  return { ios, standalone, iosOtherBrowser, browser, os };
}

/** Whether the browser offered an install prompt, and a function to show it. */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<boolean> } {
  const [canInstall, setCanInstall] = useState(false);
  useEffect(() => {
    const update = () => setCanInstall(deferred !== null);
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return {
    canInstall,
    async install() {
      if (!deferred) return false;
      const event = deferred;
      deferred = null;
      notify();
      await event.prompt();
      return (await event.userChoice).outcome === 'accepted';
    },
  };
}

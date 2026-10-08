'use client';

import { useEffect } from 'react';
import { listenForeground, registerServiceWorker } from './push';

/**
 * While a page of the app is focused, FCM hands pushes to the page instead of the service worker. Keep the worker
 * current and show those pushes anyway, so alerts (and "Send test") look the same whether or not the app is in front.
 */
export function useForegroundPush(): void {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    registerServiceWorker()
      .then(() => listenForeground())
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else stop = unsubscribe;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}

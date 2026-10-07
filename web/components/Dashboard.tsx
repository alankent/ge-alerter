'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import type { User } from 'firebase/auth';
import { listenForeground, registerServiceWorker } from '@/lib/push';
import { ConnectCard } from './ConnectCard';
import { NotificationList } from './NotificationList';
import { PushCard } from './PushCard';
import { SettingsCard } from './SettingsCard';

export function Dashboard({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const params = useSearchParams();
  const highlightId = params.get('n');

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let stop: (() => void) | undefined;
    // Make sure the worker is current, then listen for pushes while focused.
    registerServiceWorker()
      .then(() => listenForeground())
      .then((unsubscribe) => {
        stop = unsubscribe;
      })
      .catch(() => undefined);
    return () => stop?.();
  }, []);

  return (
    <main>
      <header className="top">
        <h1>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" /> GE Alerter
        </h1>
        <span className="who">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {user.photoURL && <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />}
          <span>{user.email}</span>
          <button className="link" type="button" onClick={onSignOut}>
            Sign out
          </button>
        </span>
      </header>
      <NotificationList uid={user.uid} highlightId={highlightId} />
      <PushCard uid={user.uid} />
      <SettingsCard uid={user.uid} />
      <ConnectCard />
    </main>
  );
}

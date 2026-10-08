'use client';

import { useSearchParams } from 'next/navigation';
import type { User } from 'firebase/auth';
import { useForegroundPush } from '@/lib/useForegroundPush';
import { ConnectCard } from './ConnectCard';
import { NotificationList } from './NotificationList';
import { PushCard } from './PushCard';
import { SettingsCard } from './SettingsCard';

export function Dashboard({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const params = useSearchParams();
  const highlightId = params.get('n');

  useForegroundPush();

  return (
    <main>
      <header className="top">
        <h1>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" /> GE Alerter <span className="status">Advanced</span>
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
      <p className="muted small center-text">
        <a href="/">Back to setup</a>
      </p>
    </main>
  );
}

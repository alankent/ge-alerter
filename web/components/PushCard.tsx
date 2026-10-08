'use client';

import { onValue, ref, remove } from 'firebase/database';
import { useEffect, useState } from 'react';
import { db } from '@/lib/firebase';
import { deviceKey, disablePush, enablePush, needsHomeScreenInstall, pushSupport, type PushSupport } from '@/lib/push';
import { showLocalNotification } from '@/lib/notificationDisplay';
import type { Device } from '@/lib/types';

export function PushCard({ uid }: { uid: string }) {
  const [support, setSupport] = useState<PushSupport>('unsupported');
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thisKey, setThisKey] = useState('');
  const [needsInstall, setNeedsInstall] = useState(false);

  useEffect(() => {
    setSupport(pushSupport());
    setNeedsInstall(needsHomeScreenInstall());
    setThisKey(deviceKey());
    return onValue(ref(db(), `users/${uid}/devices`), (snap) => {
      const list: Device[] = [];
      snap.forEach((child) => {
        list.push({ key: child.key as string, ...(child.val() as Omit<Device, 'key'>) });
      });
      setDevices(list);
    });
  }, [uid]);

  const registeredHere = devices.some((d) => d.key === thisKey);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSupport(pushSupport());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Notifications</h2>
      {support === 'unsupported' && needsInstall && (
        <p className="error">
          On iPhone and iPad, notifications only work from the Home Screen. In Safari tap Share, then Add to Home Screen, open the app from
          its icon, sign in and enable notifications there.
        </p>
      )}
      {support === 'unsupported' && !needsInstall && (
        <p className="error">This browser does not support Web Push. Use Chrome, Edge or Firefox on a desktop, or the Home Screen app on iPhone and iPad.</p>
      )}
      {support === 'denied' && (
        <p className="error">Notifications are blocked for this site. Allow them in the browser&apos;s site settings, then reload.</p>
      )}
      <div className="row">
        <span className={`status ${registeredHere ? 'ok' : ''}`}>{registeredHere ? 'This browser is registered' : 'This browser is not registered'}</span>
        {registeredHere ? (
          <>
            <button type="button" disabled={busy} onClick={() => run(() => showLocalNotification({ id: 'test', title: 'Test notification', body: 'Desktop notifications are working.', priority: 'normal' }))}>
              Send test
            </button>
            <button type="button" disabled={busy} onClick={() => run(() => disablePush(uid))}>
              Turn off here
            </button>
          </>
        ) : (
          <button className="primary" type="button" disabled={busy || support === 'unsupported' || support === 'denied'} onClick={() => run(() => enablePush(uid))}>
            Enable notifications
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">
        On a desktop, notifications arrive while the browser is running, even with this tab closed; install the app from the address bar for
        a window of its own. On iPhone and iPad, add the app to the Home Screen from Safari.
      </p>
      {devices.length > 0 && (
        <details>
          <summary className="small">Registered browsers ({devices.length})</summary>
          <ul className="list">
            {devices.map((d) => (
              <li key={d.key} className="row">
                <span className="grow">
                  {d.label ?? 'Browser'} {d.key === thisKey && <span className="status">this one</span>}
                  <br />
                  <span className="muted small">{d.createdAt ? new Date(d.createdAt).toLocaleString() : ''}</span>
                </span>
                <button className="danger" type="button" onClick={() => remove(ref(db(), `users/${uid}/devices/${d.key}`))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

'use client';

import { onValue, ref, update } from 'firebase/database';
import { useEffect, useState } from 'react';
import { db } from '@/lib/firebase';

export function SettingsCard({ uid }: { uid: string }) {
  const [defaultUrl, setDefaultUrl] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(
    () =>
      onValue(ref(db(), `users/${uid}/settings/defaultUrl`), (snap) => {
        const v = (snap.val() as string | null) ?? '';
        setDefaultUrl(v);
        setSaved(v);
      }),
    [uid],
  );

  async function save() {
    const value = defaultUrl.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      setStatus('Enter a full URL starting with https://');
      return;
    }
    await update(ref(db(), `users/${uid}/settings`), { defaultUrl: value || null });
    setStatus('Saved');
    setTimeout(() => setStatus(null), 1500);
  }

  return (
    <div className="card">
      <h2>Default link</h2>
      <p className="muted small">
        Opened when you click a notification that has no link of its own. Point it at your Gemini Enterprise app or inbox so one click takes you to the
        conversation that produced the alert.
      </p>
      <div className="row">
        <input className="grow" type="url" placeholder="https://geminienterprise.google.com/..." value={defaultUrl} onChange={(e) => setDefaultUrl(e.target.value)} />
        <button className="primary" type="button" disabled={defaultUrl.trim() === saved} onClick={save}>
          Save
        </button>
        {status && <span className="muted small">{status}</span>}
      </div>
    </div>
  );
}

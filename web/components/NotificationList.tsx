'use client';

import { limitToLast, onValue, query, ref, remove, update } from 'firebase/database';
import { useEffect, useMemo, useState } from 'react';
import { db } from '@/lib/firebase';
import type { AlertNotification } from '@/lib/types';

function formatTime(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function NotificationList({ uid, highlightId }: { uid: string; highlightId?: string | null }) {
  const [items, setItems] = useState<AlertNotification[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => {
    const q = query(ref(db(), `users/${uid}/notifications`), limitToLast(200));
    return onValue(q, (snap) => {
      const list: AlertNotification[] = [];
      snap.forEach((child) => {
        list.push({ id: child.key as string, ...(child.val() as Omit<AlertNotification, 'id'>) });
      });
      list.sort((a, b) => b.createdAt - a.createdAt);
      setItems(list);
    });
  }, [uid]);

  const visible = useMemo(() => (items ?? []).filter((n) => !unreadOnly || !n.read), [items, unreadOnly]);
  const unreadCount = (items ?? []).filter((n) => !n.read).length;

  const markRead = (id: string, read: boolean) => update(ref(db(), `users/${uid}/notifications/${id}`), { read, readAt: read ? Date.now() : null });
  const markAllRead = async () => {
    const updates: Record<string, unknown> = {};
    for (const n of items ?? []) {
      if (!n.read) {
        updates[`${n.id}/read`] = true;
        updates[`${n.id}/readAt`] = Date.now();
      }
    }
    if (Object.keys(updates).length) await update(ref(db(), `users/${uid}/notifications`), updates);
  };

  return (
    <div className="card">
      <div className="row">
        <h2 className="grow">
          Inbox {unreadCount > 0 && <span className="status">{unreadCount} unread</span>}
        </h2>
        <label className="small muted">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        <button type="button" disabled={unreadCount === 0} onClick={markAllRead}>
          Mark all read
        </button>
      </div>
      {items === null && <p className="muted">Loading…</p>}
      {items !== null && visible.length === 0 && (
        <p className="muted">
          {unreadOnly ? 'Nothing unread.' : 'No notifications yet. Once Gemini Enterprise is connected, every send_notification call lands here and on your desktop.'}
        </p>
      )}
      <ul className="list">
        {visible.map((n) => (
          <li key={n.id} className={`notification ${n.read ? '' : 'unread'} ${n.id === highlightId ? 'highlight' : ''}`}>
            <span className="title">
              {n.url ? (
                <a href={n.url} target="_blank" rel="noreferrer" onClick={() => markRead(n.id, true)}>
                  {n.title}
                </a>
              ) : (
                n.title
              )}
            </span>
            <span className="meta" title={new Date(n.createdAt).toISOString()}>
              {formatTime(n.createdAt)}
            </span>
            {n.body && <span className="body">{n.body}</span>}
            {(n.tags?.length || n.data) && (
              <span className="meta" style={{ gridColumn: '1 / -1' }}>
                {n.tags?.map((t) => (
                  <span className="tag" key={t}>
                    {t}
                  </span>
                ))}
                {n.data && (
                  <details>
                    <summary className="small">Details</summary>
                    <dl className="kv small">
                      {Object.entries(n.data).map(([k, v]) => (
                        <span key={k} style={{ display: 'contents' }}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </span>
                      ))}
                    </dl>
                  </details>
                )}
              </span>
            )}
            <span className="actions">
              {n.actions?.map((a) => (
                <a key={a.url + a.title} className="button" href={a.url} target="_blank" rel="noreferrer" onClick={() => markRead(n.id, true)}>
                  {a.title}
                </a>
              ))}
              <button className="link" type="button" onClick={() => markRead(n.id, !n.read)}>
                {n.read ? 'Mark unread' : 'Mark read'}
              </button>
              <button className="link danger" type="button" onClick={() => remove(ref(db(), `users/${uid}/notifications/${n.id}`))}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

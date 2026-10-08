'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { SignIn } from '@/components/SignIn';
import { API_URL } from '@/lib/firebase';
import { useAuth } from '@/lib/useAuth';

interface RequestInfo {
  clientId: string;
  clientName: string;
  scope: string;
  expiresAt: number;
}

/**
 * OAuth consent page. Gemini Enterprise's authorization request is parked on
 * the server; the signed-in user approves or declines here, and we send the
 * browser back to Gemini Enterprise with the code.
 */
function Connect() {
  const params = useSearchParams();
  const requestId = params.get('request');
  const { user, loading, error, signIn } = useAuth();
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) {
      setProblem('Missing request id. Start the connection from Gemini Enterprise.');
      return;
    }
    fetch(`${API_URL}/oauth/request/${encodeURIComponent(requestId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error_description?: string }).error_description ?? `HTTP ${r.status}`);
        setInfo((await r.json()) as RequestInfo);
      })
      .catch((e: Error) => setProblem(e.message));
  }, [requestId]);

  async function decide(approve: boolean) {
    if (!user || !requestId) return;
    setBusy(true);
    setProblem(null);
    try {
      const idToken = await user.getIdToken();
      const r = await fetch(`${API_URL}/oauth/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ request: requestId, approve }),
      });
      const body = (await r.json()) as { redirectUrl?: string; error_description?: string };
      if (!r.ok || !body.redirectUrl) throw new Error(body.error_description ?? `HTTP ${r.status}`);
      window.location.href = body.redirectUrl;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (loading) return null;
  if (!user) return <SignIn onSignIn={signIn} error={error} message="Sign in with the Google account you use in Gemini Enterprise to approve the connection." />;

  return (
    <main>
      <div className="card center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" />
        <h1>Allow {info?.clientName ?? 'this app'} to send you notifications?</h1>
        {problem ? (
          <p className="error">{problem}</p>
        ) : (
          <>
            <p className="muted">
              Agents and workflows running as <strong>{user.email}</strong> will be able to send you notifications and read your notification history.
            </p>
            <p className="row" style={{ justifyContent: 'center' }}>
              <button className="primary" type="button" disabled={busy || !info} onClick={() => decide(true)}>
                Allow
              </button>
              <button type="button" disabled={busy || !info} onClick={() => decide(false)}>
                Deny
              </button>
            </p>
            <p className="callout small">
              Notifications pop up only on devices where you’ve turned them on.{' '}
              <a href="/" target="_blank" rel="noopener">
                Set up this device
              </a>{' '}
              in a new tab, then come back here and click Allow.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <Connect />
    </Suspense>
  );
}

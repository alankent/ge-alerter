'use client';

import { isConfigured } from '@/lib/firebase';

export function SignIn({ onSignIn, error, message }: { onSignIn: () => void; error: string | null; message?: string }) {
  return (
    <main>
      <div className="card center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" />
        <h1>GE Alerter</h1>
        <p className="muted">{message ?? 'Desktop notifications from your Gemini Enterprise agents and workflows.'}</p>
        {isConfigured ? (
          <p>
            <button className="primary" type="button" onClick={onSignIn}>
              Sign in with Google
            </button>
          </p>
        ) : (
          <p className="error">
            Firebase is not configured. Copy <code>web/.env.example</code> to <code>web/.env.local</code> and fill in your project values.
          </p>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </main>
  );
}

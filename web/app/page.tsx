'use client';

import { Suspense } from 'react';
import { Dashboard } from '@/components/Dashboard';
import { SignIn } from '@/components/SignIn';
import { useAuth } from '@/lib/useAuth';

function Home() {
  const { user, loading, error, signIn, signOut } = useAuth();
  if (loading) {
    return (
      <main>
        <p className="muted center">Loading…</p>
      </main>
    );
  }
  if (!user) return <SignIn onSignIn={signIn} error={error} />;
  return <Dashboard user={user} onSignOut={signOut} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Home />
    </Suspense>
  );
}

'use client';

import { onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut as fbSignOut, type User } from 'firebase/auth';
import { ref, update } from 'firebase/database';
import { useEffect, useState } from 'react';
import { allowedDomainsText, auth, db, googleProvider, isAllowedEmail, isConfigured } from './firebase';

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth(), (u) => {
      if (u && !isAllowedEmail(u.email, u.emailVerified)) {
        setError(`${u.email ?? 'That account'} is not allowed. Sign in with your ${allowedDomainsText} account.`);
        setUser(null);
        setLoading(false);
        void fbSignOut(auth());
        return;
      }
      setUser(u);
      setLoading(false);
      if (u) {
        setError(null);
        // Keep a profile so the inbox can show who is signed in; the server never needs it.
        void update(ref(db(), `users/${u.uid}/profile`), {
          email: u.email ?? null,
          displayName: u.displayName ?? null,
          photoURL: u.photoURL ?? null,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      }
    });
  }, []);

  return {
    user,
    loading,
    error,
    async signIn() {
      try {
        await signInWithPopup(auth(), googleProvider);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          // Embedded webviews and some installed-PWA windows cannot open popups; the auth domain is this origin,
          // so a full-page redirect is reliable there.
          await signInWithRedirect(auth(), googleProvider);
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    async signOut() {
      await fbSignOut(auth());
    },
  };
}

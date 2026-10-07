'use client';

import { onAuthStateChanged, signInWithPopup, signOut as fbSignOut, type User } from 'firebase/auth';
import { ref, update } from 'firebase/database';
import { useEffect, useState } from 'react';
import { auth, db, googleProvider, isConfigured } from './firebase';

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
      setUser(u);
      setLoading(false);
      if (u) {
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
      setError(null);
      try {
        await signInWithPopup(auth(), googleProvider);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    async signOut() {
      await fbSignOut(auth());
    },
  };
}

'use client';

import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging';

export const firebaseConfig: FirebaseOptions = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY ?? '';
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
export const GEMINI_ENTERPRISE_REDIRECT_URI = 'https://vertexaisearch.cloud.google.com/oauth-redirect';

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.databaseURL);

function app(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function auth(): Auth {
  return getAuth(app());
}

export function db(): Database {
  return getDatabase(app());
}

/** Lower-case email domains allowed to use the app, e.g. ["imdigital.com"]. Empty allows any Google account. */
export const ALLOWED_EMAIL_DOMAINS = (process.env.NEXT_PUBLIC_ALLOWED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);

export function isAllowedEmail(email: string | null | undefined, verified: boolean): boolean {
  if (ALLOWED_EMAIL_DOMAINS.length === 0) return true;
  if (!email || !verified) return false;
  return ALLOWED_EMAIL_DOMAINS.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
}

export const allowedDomainsText = ALLOWED_EMAIL_DOMAINS.map((d) => `@${d}`).join(' or ');

export const googleProvider = new GoogleAuthProvider();
// Steer Google's account chooser to the company domain. This is only a hint; the database rules and server enforce it.
googleProvider.setCustomParameters(
  ALLOWED_EMAIL_DOMAINS.length === 1 ? { hd: ALLOWED_EMAIL_DOMAINS[0], prompt: 'select_account' } : { prompt: 'select_account' },
);

export async function messaging(): Promise<Messaging | null> {
  if (typeof window === 'undefined') return null;
  if (!(await isSupported())) return null;
  return getMessaging(app());
}

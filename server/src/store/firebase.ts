import { getApps, initializeApp, applicationDefault, cert, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';
import type {
  AccessToken,
  AuthCode,
  DeviceRecord,
  Identity,
  NotificationRecord,
  PendingAuth,
  Pusher,
  PushResult,
  RefreshToken,
  Store,
  UserSettings,
  VerifiedUser,
} from './types.js';

export interface FirebaseOptions {
  databaseUrl: string;
  projectId?: string;
}

/**
 * Initialises the Firebase Admin SDK.
 *
 * On Cloud Run the default service account is used (Application Default
 * Credentials). Locally, point GOOGLE_APPLICATION_CREDENTIALS at a service
 * account key, or set FIREBASE_SERVICE_ACCOUNT_JSON to the key's contents.
 */
export function initFirebase(options: FirebaseOptions): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const inlineKey = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credential = inlineKey ? cert(JSON.parse(inlineKey)) : applicationDefault();
  return initializeApp({ credential, databaseURL: options.databaseUrl, projectId: options.projectId });
}

/*
 * Realtime Database layout
 *
 *   /oauth/pending/{id}          PendingAuth   (server only)
 *   /oauth/codes/{sha256}        AuthCode      (server only)
 *   /oauth/tokens/{sha256}       AccessToken   (server only)
 *   /oauth/refresh/{sha256}      RefreshToken  (server only)
 *   /users/{uid}/settings        UserSettings  (owner read/write)
 *   /users/{uid}/profile         { email, displayName }  (owner read/write)
 *   /users/{uid}/devices/{key}   { token, userAgent, createdAt }  (owner read/write)
 *   /users/{uid}/notifications/{pushId}  NotificationRecord minus id  (owner read/write)
 *
 * The admin SDK bypasses security rules; see database.rules.json for the
 * rules that apply to the PWA.
 */
export class FirebaseStore implements Store {
  private db: Database;

  constructor(app: App) {
    this.db = getDatabase(app);
  }

  private async take<T>(path: string): Promise<T | null> {
    const ref = this.db.ref(path);
    const snap = await ref.get();
    if (!snap.exists()) return null;
    await ref.remove();
    return snap.val() as T;
  }

  /** Removes expired children of a bucket so abandoned flows do not pile up. */
  private async sweep(path: string): Promise<void> {
    try {
      const snap = await this.db.ref(path).orderByChild('exp').endAt(Date.now()).limitToFirst(50).get();
      if (!snap.exists()) return;
      const updates: Record<string, null> = {};
      snap.forEach((child) => {
        updates[child.key as string] = null;
      });
      await this.db.ref(path).update(updates);
    } catch (err) {
      console.warn(`sweep ${path} failed`, err);
    }
  }

  async putPendingAuth(id: string, pending: PendingAuth): Promise<void> {
    await this.sweep('oauth/pending');
    await this.db.ref(`oauth/pending/${id}`).set(pending);
  }
  async takePendingAuth(id: string): Promise<PendingAuth | null> {
    return this.take<PendingAuth>(`oauth/pending/${id}`);
  }
  async peekPendingAuth(id: string): Promise<PendingAuth | null> {
    const snap = await this.db.ref(`oauth/pending/${id}`).get();
    return snap.exists() ? (snap.val() as PendingAuth) : null;
  }

  async putCode(codeHash: string, code: AuthCode): Promise<void> {
    await this.sweep('oauth/codes');
    await this.db.ref(`oauth/codes/${codeHash}`).set(code);
  }
  async takeCode(codeHash: string): Promise<AuthCode | null> {
    return this.take<AuthCode>(`oauth/codes/${codeHash}`);
  }

  async putAccessToken(tokenHash: string, token: AccessToken): Promise<void> {
    await this.sweep('oauth/tokens');
    await this.db.ref(`oauth/tokens/${tokenHash}`).set(token);
  }
  async getAccessToken(tokenHash: string): Promise<AccessToken | null> {
    const snap = await this.db.ref(`oauth/tokens/${tokenHash}`).get();
    return snap.exists() ? (snap.val() as AccessToken) : null;
  }

  async putRefreshToken(tokenHash: string, token: RefreshToken): Promise<void> {
    await this.sweep('oauth/refresh');
    await this.db.ref(`oauth/refresh/${tokenHash}`).set(token);
  }
  async getRefreshToken(tokenHash: string): Promise<RefreshToken | null> {
    const snap = await this.db.ref(`oauth/refresh/${tokenHash}`).get();
    return snap.exists() ? (snap.val() as RefreshToken) : null;
  }
  async deleteRefreshToken(tokenHash: string): Promise<void> {
    await this.db.ref(`oauth/refresh/${tokenHash}`).remove();
  }

  async getUserSettings(uid: string): Promise<UserSettings> {
    const snap = await this.db.ref(`users/${uid}/settings`).get();
    return snap.exists() ? (snap.val() as UserSettings) : {};
  }

  async addNotification(uid: string, notification: Omit<NotificationRecord, 'id'>): Promise<string> {
    const ref = this.db.ref(`users/${uid}/notifications`).push();
    await ref.set(stripUndefined(notification));
    return ref.key as string;
  }
  async listNotifications(uid: string, limit: number): Promise<NotificationRecord[]> {
    const snap = await this.db.ref(`users/${uid}/notifications`).orderByChild('createdAt').limitToLast(limit).get();
    const out: NotificationRecord[] = [];
    snap.forEach((child) => {
      out.push({ ...(child.val() as Omit<NotificationRecord, 'id'>), id: child.key as string });
    });
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  async getNotification(uid: string, id: string): Promise<NotificationRecord | null> {
    const snap = await this.db.ref(`users/${uid}/notifications/${id}`).get();
    return snap.exists() ? { ...(snap.val() as Omit<NotificationRecord, 'id'>), id } : null;
  }
  async markRead(uid: string, id: string): Promise<boolean> {
    const ref = this.db.ref(`users/${uid}/notifications/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return false;
    await ref.update({ read: true, readAt: Date.now() });
    return true;
  }

  async listDevices(uid: string): Promise<DeviceRecord[]> {
    const snap = await this.db.ref(`users/${uid}/devices`).get();
    const out: DeviceRecord[] = [];
    snap.forEach((child) => {
      const v = child.val() as Omit<DeviceRecord, 'key'>;
      if (v?.token) out.push({ ...v, key: child.key as string });
    });
    return out;
  }
  async removeDevice(uid: string, key: string): Promise<void> {
    await this.db.ref(`users/${uid}/devices/${key}`).remove();
  }
}

/** Realtime Database rejects `undefined` values, so drop them. */
function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/** Sends data-only Web Push messages through Firebase Cloud Messaging. */
export class FcmPusher implements Pusher {
  constructor(private app: App) {}

  async send(tokens: string[], data: Record<string, string>, priority: 'normal' | 'high'): Promise<PushResult> {
    if (tokens.length === 0) return { invalidTokens: [], successCount: 0 };
    const res = await getMessaging(this.app).sendEachForMulticast({
      tokens,
      data,
      webpush: {
        headers: {
          Urgency: priority === 'high' ? 'high' : 'normal',
          TTL: String(7 * 24 * 3600),
        },
      },
    });
    const invalidTokens: string[] = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error?.code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument'
      ) {
        invalidTokens.push(tokens[i]);
      } else {
        console.warn('FCM send failed', code, r.error?.message);
      }
    });
    return { invalidTokens, successCount: res.successCount };
  }
}

/** Verifies Firebase Auth ID tokens minted by the PWA. */
export class FirebaseIdentity implements Identity {
  constructor(private app: App) {}

  async verifyIdToken(idToken: string): Promise<VerifiedUser> {
    const decoded = await getAuth(this.app).verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true };
  }
}

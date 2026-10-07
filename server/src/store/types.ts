/**
 * Storage, push and identity abstractions.
 *
 * The production implementations live on Firebase (Realtime Database,
 * Cloud Messaging, Auth). The in-memory implementations back the tests and
 * local development without any Google Cloud project.
 */

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  /** Unix millis. */
  exp: number;
}

export interface AuthCode {
  uid: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256' | 'plain';
  exp: number;
}

export interface AccessToken {
  uid: string;
  clientId: string;
  scope?: string;
  exp: number;
}

export interface RefreshToken {
  uid: string;
  clientId: string;
  scope?: string;
  exp: number;
}

export interface NotificationAction {
  /** Button label, keep it short. */
  title: string;
  /** URL opened when the button is clicked. */
  url: string;
}

export interface NotificationInput {
  title: string;
  body?: string;
  /** URL opened when the notification itself is clicked. */
  url?: string;
  actions?: NotificationAction[];
  priority?: 'normal' | 'high';
  tags?: string[];
  /** Free-form extra data an agent wants to attach (shown in the inbox detail). */
  data?: Record<string, string>;
}

export interface NotificationRecord extends NotificationInput {
  id: string;
  /** Unix millis. */
  createdAt: number;
  read: boolean;
  readAt?: number;
  /** Where it came from: "mcp" (tool call) or "api" (REST). */
  source: string;
  /** OAuth client that sent it. */
  clientId?: string;
}

export interface DeviceRecord {
  key: string;
  token: string;
  userAgent?: string;
  createdAt?: number;
}

export interface UserSettings {
  /** Opened when a notification carries no URL of its own. */
  defaultUrl?: string;
}

export interface Store {
  putPendingAuth(id: string, pending: PendingAuth): Promise<void>;
  /** Returns and deletes the pending authorization request. */
  takePendingAuth(id: string): Promise<PendingAuth | null>;
  peekPendingAuth(id: string): Promise<PendingAuth | null>;

  putCode(codeHash: string, code: AuthCode): Promise<void>;
  takeCode(codeHash: string): Promise<AuthCode | null>;

  putAccessToken(tokenHash: string, token: AccessToken): Promise<void>;
  getAccessToken(tokenHash: string): Promise<AccessToken | null>;

  putRefreshToken(tokenHash: string, token: RefreshToken): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<RefreshToken | null>;
  deleteRefreshToken(tokenHash: string): Promise<void>;

  getUserSettings(uid: string): Promise<UserSettings>;

  addNotification(uid: string, notification: Omit<NotificationRecord, 'id'>): Promise<string>;
  listNotifications(uid: string, limit: number): Promise<NotificationRecord[]>;
  getNotification(uid: string, id: string): Promise<NotificationRecord | null>;
  markRead(uid: string, id: string): Promise<boolean>;

  listDevices(uid: string): Promise<DeviceRecord[]>;
  removeDevice(uid: string, key: string): Promise<void>;
}

export interface PushResult {
  /** Device tokens that FCM reports as dead and should be removed. */
  invalidTokens: string[];
  successCount: number;
}

export interface Pusher {
  send(tokens: string[], data: Record<string, string>, priority: 'normal' | 'high'): Promise<PushResult>;
}

export interface Identity {
  /** Verifies a Firebase Auth ID token issued to the PWA and returns the user. */
  verifyIdToken(idToken: string): Promise<{ uid: string; email?: string }>;
}

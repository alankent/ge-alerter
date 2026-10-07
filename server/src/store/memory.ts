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
} from './types.js';

/** In-memory store for tests and local development. Nothing survives a restart. */
export class MemoryStore implements Store {
  pending = new Map<string, PendingAuth>();
  codes = new Map<string, AuthCode>();
  accessTokens = new Map<string, AccessToken>();
  refreshTokens = new Map<string, RefreshToken>();
  settings = new Map<string, UserSettings>();
  notifications = new Map<string, NotificationRecord[]>();
  devices = new Map<string, DeviceRecord[]>();
  private counter = 0;

  async putPendingAuth(id: string, pending: PendingAuth): Promise<void> {
    this.pending.set(id, pending);
  }
  async takePendingAuth(id: string): Promise<PendingAuth | null> {
    const p = this.pending.get(id) ?? null;
    this.pending.delete(id);
    return p;
  }
  async peekPendingAuth(id: string): Promise<PendingAuth | null> {
    return this.pending.get(id) ?? null;
  }
  async putCode(codeHash: string, code: AuthCode): Promise<void> {
    this.codes.set(codeHash, code);
  }
  async takeCode(codeHash: string): Promise<AuthCode | null> {
    const c = this.codes.get(codeHash) ?? null;
    this.codes.delete(codeHash);
    return c;
  }
  async putAccessToken(tokenHash: string, token: AccessToken): Promise<void> {
    this.accessTokens.set(tokenHash, token);
  }
  async getAccessToken(tokenHash: string): Promise<AccessToken | null> {
    return this.accessTokens.get(tokenHash) ?? null;
  }
  async putRefreshToken(tokenHash: string, token: RefreshToken): Promise<void> {
    this.refreshTokens.set(tokenHash, token);
  }
  async getRefreshToken(tokenHash: string): Promise<RefreshToken | null> {
    return this.refreshTokens.get(tokenHash) ?? null;
  }
  async deleteRefreshToken(tokenHash: string): Promise<void> {
    this.refreshTokens.delete(tokenHash);
  }
  async getUserSettings(uid: string): Promise<UserSettings> {
    return this.settings.get(uid) ?? {};
  }
  async addNotification(uid: string, notification: Omit<NotificationRecord, 'id'>): Promise<string> {
    const id = `n${++this.counter}`;
    const list = this.notifications.get(uid) ?? [];
    list.push({ ...notification, id });
    this.notifications.set(uid, list);
    return id;
  }
  async listNotifications(uid: string, limit: number): Promise<NotificationRecord[]> {
    const list = this.notifications.get(uid) ?? [];
    return [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async getNotification(uid: string, id: string): Promise<NotificationRecord | null> {
    return (this.notifications.get(uid) ?? []).find((n) => n.id === id) ?? null;
  }
  async markRead(uid: string, id: string): Promise<boolean> {
    const n = await this.getNotification(uid, id);
    if (!n) return false;
    n.read = true;
    n.readAt = Date.now();
    return true;
  }
  async listDevices(uid: string): Promise<DeviceRecord[]> {
    return this.devices.get(uid) ?? [];
  }
  async removeDevice(uid: string, key: string): Promise<void> {
    this.devices.set(uid, (this.devices.get(uid) ?? []).filter((d) => d.key !== key));
  }
}

/** Records pushes instead of sending them. */
export class MemoryPusher implements Pusher {
  sent: Array<{ tokens: string[]; data: Record<string, string>; priority: string }> = [];
  invalid = new Set<string>();

  async send(tokens: string[], data: Record<string, string>, priority: 'normal' | 'high'): Promise<PushResult> {
    this.sent.push({ tokens, data, priority });
    const invalidTokens = tokens.filter((t) => this.invalid.has(t));
    return { invalidTokens, successCount: tokens.length - invalidTokens.length };
  }
}

/** Maps literal "ID tokens" to users. */
export class MemoryIdentity implements Identity {
  constructor(private users: Record<string, { uid: string; email?: string }>) {}

  async verifyIdToken(idToken: string): Promise<{ uid: string; email?: string }> {
    const user = this.users[idToken];
    if (!user) throw new Error('invalid id token');
    return user;
  }
}

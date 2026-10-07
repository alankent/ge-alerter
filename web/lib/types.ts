export interface NotificationAction {
  title: string;
  url: string;
}

export interface AlertNotification {
  id: string;
  title: string;
  body?: string;
  url?: string;
  actions?: NotificationAction[];
  priority?: 'normal' | 'high';
  tags?: string[];
  data?: Record<string, string>;
  createdAt: number;
  read: boolean;
  readAt?: number;
  source?: string;
  clientId?: string;
}

export interface Device {
  key: string;
  token: string;
  userAgent?: string;
  createdAt?: number;
  label?: string;
}

export interface UserSettings {
  defaultUrl?: string;
}

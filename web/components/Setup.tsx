'use client';

import type { User } from 'firebase/auth';
import { onValue, ref } from 'firebase/database';
import { useEffect, useState, type ReactNode } from 'react';
import { db, isConfigured } from '@/lib/firebase';
import { detectPlatform, useInstallPrompt, type Platform } from '@/lib/install';
import { deviceKey, disablePush, enablePush, pushSupport, sendTestPush, type PushSupport } from '@/lib/push';
import { useAuth } from '@/lib/useAuth';
import { useForegroundPush } from '@/lib/useForegroundPush';

/** The page end users land on: sign in, turn on notifications, install. Technical details live on /advanced. */
export function Setup() {
  const { user, loading, error, signIn, signOut } = useAuth();
  const [platform, setPlatform] = useState<Platform | null>(null);
  useForegroundPush();
  useEffect(() => setPlatform(detectPlatform()), []);

  if (loading || !platform) {
    return (
      <Shell>
        <p className="muted center-text">Loading…</p>
      </Shell>
    );
  }

  // Apple only delivers Web Push to Home Screen apps, and a Safari tab does not share its sign-in with the
  // Home Screen app, so on iPhone and iPad installing comes first and everything else happens in the app.
  if (platform.ios && !platform.standalone) {
    return (
      <Shell>
        <IosInstall otherBrowser={platform.iosOtherBrowser} />
      </Shell>
    );
  }

  const footer = (
    <footer className="setup-footer muted small">
      {user && (
        <>
          <button className="link" type="button" onClick={signOut}>
            Sign out
          </button>
          <span aria-hidden="true">·</span>
        </>
      )}
      <a href="/advanced">Notification history and advanced settings</a>
    </footer>
  );

  return (
    <Shell footer={footer}>
      <ol className="setup-steps">
        <Step n={1} title="Sign in" done={Boolean(user)}>
          {user ? (
            <p className="muted">Signed in as {user.email}</p>
          ) : (
            <>
              <p className="muted">Use your work Google account.</p>
              {isConfigured ? (
                <button className="primary btn-lg" type="button" onClick={signIn}>
                  Sign in with Google
                </button>
              ) : (
                <p className="error">This app is not configured yet.</p>
              )}
              {error && <p className="error small">{error}</p>}
            </>
          )}
        </Step>
        <NotificationsStep user={user} platform={platform} />
        {!platform.ios && <InstallStep platform={platform} />}
      </ol>
    </Shell>
  );
}

function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="setup">
      <div className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" />
        <h1>Agent Notifications</h1>
        <p className="muted">Notifications from your Gemini Enterprise agents and workflows, on this device.</p>
      </div>
      <div className="card setup-card">{children}</div>
      {footer}
    </main>
  );
}

function Step({ n, title, done, optional, children }: { n: number; title: string; done?: boolean; optional?: boolean; children: ReactNode }) {
  return (
    <li className={`step${done ? ' done' : ''}`}>
      <span className="step-num" aria-hidden="true">
        {done ? '✓' : n}
      </span>
      <div className="step-body">
        <h2>
          {title}
          {optional && <span className="pill">Optional</span>}
          {done && <span className="visually-hidden"> (done)</span>}
        </h2>
        {children}
      </div>
    </li>
  );
}

function NotificationsStep({ user, platform }: { user: User | null; platform: Platform }) {
  const [support, setSupport] = useState<PushSupport>('unsupported');
  const [registered, setRegistered] = useState(false);
  const [others, setOthers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => setSupport(pushSupport()), []);
  useEffect(() => {
    if (!user) return;
    const key = deviceKey();
    return onValue(ref(db(), `users/${user.uid}/devices`), (snap) => {
      let mine = false;
      let count = 0;
      snap.forEach((child) => {
        if (child.key === key) mine = true;
        else count++;
      });
      setRegistered(mine);
      setOthers(count);
    });
  }, [user]);

  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setMessage(null);
    setProblem(null);
    try {
      await fn();
      if (success) setMessage(success);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSupport(pushSupport());
      setBusy(false);
    }
  }

  const on = registered && support === 'granted';
  return (
    <Step n={2} title="Turn on notifications" done={on}>
      {!user ? (
        <p className="muted">Sign in first.</p>
      ) : support === 'unsupported' ? (
        <p className="error">This browser can’t receive notifications. Open this page in Chrome or Edge.</p>
      ) : support === 'denied' ? (
        <p className="error">
          {platform.ios
            ? 'Notifications are turned off for this app. Open Settings, then Notifications, then Agents, and allow them.'
            : 'Notifications are blocked for this site. Click the icon at the left of the address bar, set Notifications to Allow, then reload this page.'}
        </p>
      ) : on ? (
        <>
          <p>
            <span className="pill ok">On for this device</span>
          </p>
          <div className="row">
            <button className="primary" type="button" disabled={busy} onClick={() => run(() => sendTestPush(user), 'Test sent. It should appear in a few seconds.')}>
              Send test
            </button>
            <button type="button" disabled={busy} onClick={() => run(() => disablePush(user.uid), 'Notifications are off for this device.')}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Your browser will ask for permission. Choose Allow.</p>
          <button className="primary btn-lg" type="button" disabled={busy} onClick={() => run(() => enablePush(user.uid), 'Done. Send a test to check it works.')}>
            Turn on notifications
          </button>
        </>
      )}
      {message && <p className="small">{message}</p>}
      {problem && <p className="error small">{problem}</p>}
      {user && others > 0 && (
        <p className="muted small">
          Also on {others} other {others === 1 ? 'device' : 'devices'}.
        </p>
      )}
    </Step>
  );
}

function InstallStep({ platform }: { platform: Platform }) {
  const { canInstall, install } = useInstallPrompt();
  if (platform.standalone) {
    return (
      <Step n={3} title="Install the app" done>
        <p className="muted">Installed. You’re using the app.</p>
      </Step>
    );
  }
  return (
    <Step n={3} title="Install the app" optional>
      <p className="muted">Gives Agent Notifications its own window, so your notifications are one click away.</p>
      {canInstall ? (
        <button className="primary" type="button" onClick={() => void install()}>
          Install app
        </button>
      ) : platform.browser === 'chrome' || platform.browser === 'edge' ? (
        <p className="small">Already installed? Open it from your Start menu or Dock. If not, click the install icon at the right of the address bar.</p>
      ) : platform.browser === 'safari' ? (
        <p className="small">In Safari, choose File, then Add to Dock.</p>
      ) : (
        <p className="small">This browser can’t install apps. Notifications still arrive while it’s running.</p>
      )}
    </Step>
  );
}

function ShareIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 24 24" aria-label="Share" role="img">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" />
      <path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function IosInstall({ otherBrowser }: { otherBrowser: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <h2 className="setup-title">Add Agent Notifications to your Home Screen</h2>
      <p className="muted">On iPhone and iPad, notifications only arrive in the Home Screen app. It takes a few taps.</p>
      {otherBrowser && (
        <div className="callout">
          <p>
            <strong>First, open this page in Safari.</strong> Other browsers on iPhone and iPad can’t set up notifications.
          </p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.origin).then(() => setCopied(true));
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </button>
        </div>
      )}
      <ol className="setup-steps">
        <Step n={1} title="Tap Share">
          <p className="muted">
            Tap <ShareIcon /> in Safari’s toolbar: at the top on iPad, at the bottom on iPhone.
          </p>
        </Step>
        <Step n={2} title="Tap Add to Home Screen">
          <p className="muted">
            Scroll down the menu and tap <AddIcon /> <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
          </p>
        </Step>
        <Step n={3} title="Open Agents from your Home Screen">
          <p className="muted">Sign in there and tap Turn on notifications. You can close this Safari tab.</p>
        </Step>
      </ol>
    </>
  );
}

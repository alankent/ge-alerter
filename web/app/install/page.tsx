'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AddIcon, ShareIcon } from '@/components/Icons';
import { Step } from '@/components/Setup';
import { detectPlatform } from '@/lib/install';

/**
 * Setup instructions for every kind of device, readable without signing in, so people can follow them for a device
 * other than the one they are holding. The server's get_setup_instructions tool relays the same steps; keep the two
 * in step (server/src/setupGuide.ts).
 */
type Tab = 'ios' | 'windows' | 'mac' | 'android' | 'other';
const TABS: { id: Tab; label: string }[] = [
  { id: 'ios', label: 'iPhone & iPad' },
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'Mac' },
  { id: 'android', label: 'Android' },
  { id: 'other', label: 'Other' },
];
const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

export default function InstallPage() {
  const [tab, setTab] = useState<Tab>('windows');
  const [here, setHere] = useState<Tab | null>(null);

  useEffect(() => {
    const os = detectPlatform().os;
    setHere(os);
    const fromHash = window.location.hash.slice(1);
    setTab(isTab(fromHash) ? fromHash : os);
  }, []);

  function choose(next: Tab) {
    setTab(next);
    history.replaceState(null, '', `#${next}`);
  }

  return (
    <main className="setup">
      <div className="hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" />
        <h1>Set up Agent Notifications</h1>
        <p className="muted">Do this on each device where you want notifications. It takes about a minute.</p>
      </div>
      <div className="tabs" role="tablist" aria-label="Device">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => choose(t.id)}>
            {t.label}
            {here === t.id && <span className="visually-hidden"> (this device)</span>}
          </button>
        ))}
      </div>
      <div className="card setup-card" role="tabpanel">
        {here === tab && <p className="pill this-device">This device</p>}
        <Guide tab={tab} />
      </div>
      <footer className="setup-footer muted small">
        <a href="/">Back to setup</a>
      </footer>
    </main>
  );
}

function Guide({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'ios':
      return (
        <>
          <Intro>Notifications on iPhone and iPad only work from the Home Screen app, added from Safari. Requires iOS or iPadOS 16.4 or later.</Intro>
          <ol className="setup-steps">
            <Step n={1} title="Open the page in Safari">
              <p className="muted">
                Go to <SetupLink /> in <strong>Safari</strong>. Chrome and other browsers on iPhone and iPad can’t set up notifications.
              </p>
            </Step>
            <Step n={2} title="Add it to your Home Screen">
              <p className="muted">
                Tap <ShareIcon /> Share (at the top on iPad, at the bottom on iPhone), scroll down, tap <AddIcon /> <strong>Add to Home Screen</strong>,
                then <strong>Add</strong>.
              </p>
            </Step>
            <Step n={3} title="Open Agents from your Home Screen">
              <p className="muted">Not from Safari. Sign in with your work Google account.</p>
            </Step>
            <Step n={4} title="Turn on notifications">
              <p className="muted">
                Tap <strong>Turn on notifications</strong>, choose <strong>Allow</strong>, then tap <strong>Send test</strong>.
              </p>
            </Step>
          </ol>
          <Trouble>
            Open <strong>Settings</strong>, then <strong>Notifications</strong>, then <strong>Agents</strong>, and allow notifications. Check that a Focus mode
            isn’t silencing them.
          </Trouble>
        </>
      );
    case 'windows':
      return (
        <>
          <Intro>Use Chrome or Microsoft Edge.</Intro>
          <ol className="setup-steps">
            <Step n={1} title="Open the setup page">
              <p className="muted">
                Go to <SetupLink /> in Chrome or Edge and sign in with your work Google account.
              </p>
            </Step>
            <Step n={2} title="Turn on notifications">
              <p className="muted">
                Click <strong>Turn on notifications</strong>, choose <strong>Allow</strong>, then click <strong>Send test</strong>.
              </p>
            </Step>
            <Step n={3} title="Install the app" optional>
              <p className="muted">
                Click <strong>Install app</strong>, or the install icon at the right of the address bar. It gets its own window and a Start menu entry.
              </p>
            </Step>
          </ol>
          <Trouble>
            Open <strong>Settings</strong>, then <strong>System</strong>, then <strong>Notifications</strong>. Make sure notifications are on for Chrome or Edge (or
            Agent Notifications) and that Do not disturb is off. Notifications arrive while the browser is running.
          </Trouble>
        </>
      );
    case 'mac':
      return (
        <>
          <Intro>Use Chrome, Microsoft Edge or Safari.</Intro>
          <ol className="setup-steps">
            <Step n={1} title="Open the setup page">
              <p className="muted">
                Go to <SetupLink /> and sign in with your work Google account.
              </p>
            </Step>
            <Step n={2} title="Turn on notifications">
              <p className="muted">
                Click <strong>Turn on notifications</strong>, choose <strong>Allow</strong>, then click <strong>Send test</strong>.
              </p>
            </Step>
            <Step n={3} title="Install the app" optional>
              <p className="muted">
                In Chrome or Edge, click <strong>Install app</strong> or the install icon in the address bar. In Safari, choose <strong>File</strong>, then{' '}
                <strong>Add to Dock</strong>.
              </p>
            </Step>
          </ol>
          <Trouble>
            Open <strong>System Settings</strong>, then <strong>Notifications</strong>, and allow notifications for your browser (or Agent Notifications). Choose{' '}
            <strong>Alerts</strong> instead of Banners to keep them on screen until you dismiss them. Check that a Focus mode isn’t on.
          </Trouble>
        </>
      );
    case 'android':
      return (
        <>
          <Intro>Use Chrome.</Intro>
          <ol className="setup-steps">
            <Step n={1} title="Open the setup page">
              <p className="muted">
                Go to <SetupLink /> in Chrome.
              </p>
            </Step>
            <Step n={2} title="Install the app">
              <p className="muted">
                Tap <strong>Install app</strong>, or open Chrome’s menu and choose <strong>Add to Home screen</strong>, then <strong>Install</strong>.
              </p>
            </Step>
            <Step n={3} title="Turn on notifications">
              <p className="muted">
                Sign in with your work Google account, tap <strong>Turn on notifications</strong>, choose <strong>Allow</strong>, then tap{' '}
                <strong>Send test</strong>.
              </p>
            </Step>
          </ol>
          <Trouble>
            Open Android <strong>Settings</strong>, then <strong>Notifications</strong>, and allow them for Chrome or Agent Notifications.
          </Trouble>
        </>
      );
    case 'other':
      return (
        <>
          <Intro>ChromeOS, Linux and other systems: use Chrome, Microsoft Edge or Firefox.</Intro>
          <ol className="setup-steps">
            <Step n={1} title="Open the setup page">
              <p className="muted">
                Go to <SetupLink /> and sign in with your work Google account.
              </p>
            </Step>
            <Step n={2} title="Turn on notifications">
              <p className="muted">
                Click <strong>Turn on notifications</strong>, choose <strong>Allow</strong>, then click <strong>Send test</strong>.
              </p>
            </Step>
          </ol>
          <Trouble>Notifications arrive while the browser is running. Firefox can’t install the app, but notifications still work.</Trouble>
        </>
      );
  }
}

function SetupLink() {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.host), []);
  return <a href="/">{origin || 'the setup page'}</a>;
}

function Intro({ children }: { children: ReactNode }) {
  return <p className="muted install-intro">{children}</p>;
}

function Trouble({ children }: { children: ReactNode }) {
  return (
    <details className="trouble">
      <summary>Not seeing notifications?</summary>
      <p className="small">{children}</p>
    </details>
  );
}

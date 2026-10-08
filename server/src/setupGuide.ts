/**
 * Plain-text setup steps that agents can relay to a user who is not getting notifications. The web app's /install
 * page shows the same steps with pictures; keep the two in step.
 */
export const PLATFORMS = ['ios', 'windows', 'mac', 'android', 'other'] as const;
export type SetupPlatform = (typeof PLATFORMS)[number];

const LABELS: Record<SetupPlatform, string> = {
  ios: 'iPhone and iPad',
  windows: 'Windows',
  mac: 'Mac',
  android: 'Android',
  other: 'ChromeOS, Linux and other browsers',
};

function steps(platform: SetupPlatform, webUrl: string): string[] {
  switch (platform) {
    case 'ios':
      return [
        `Open ${webUrl} in Safari (not Chrome or another browser). Requires iOS or iPadOS 16.4 or later.`,
        'Tap the Share button, then Add to Home Screen, then Add.',
        'Open "Agents" from the Home Screen. Notifications only work from there, not from a Safari tab.',
        'Sign in with your work Google account, tap Turn on notifications and choose Allow.',
        'Tap Send test to check. If nothing appears, open Settings > Notifications > Agents and allow notifications, and check that a Focus mode is not silencing them.',
      ];
    case 'windows':
      return [
        `Open ${webUrl} in Chrome or Edge.`,
        'Sign in with your work Google account, click Turn on notifications and choose Allow.',
        'Click Send test to check.',
        'Optional: click Install app (or the install icon at the right of the address bar) to give it its own window.',
        'If nothing appears, open Windows Settings > System > Notifications, make sure notifications are on for Chrome or Edge (or Agent Notifications), and turn off Do not disturb. Notifications arrive while the browser is running.',
      ];
    case 'mac':
      return [
        `Open ${webUrl} in Chrome, Edge or Safari.`,
        'Sign in with your work Google account, click Turn on notifications and choose Allow.',
        'Click Send test to check.',
        'Optional: install it for its own window. In Chrome or Edge click Install app or the install icon in the address bar; in Safari choose File > Add to Dock.',
        'If nothing appears, open System Settings > Notifications, allow notifications for your browser (or Agent Notifications), and choose Alerts instead of Banners if you want them to stay on screen until dismissed. Check that a Focus mode is not on.',
      ];
    case 'android':
      return [
        `Open ${webUrl} in Chrome.`,
        'Tap Install app, or open the Chrome menu and choose Add to Home screen > Install.',
        'Sign in with your work Google account, tap Turn on notifications and choose Allow.',
        'Tap Send test to check. If nothing appears, open Android Settings > Notifications and allow them for Chrome or Agent Notifications.',
      ];
    case 'other':
      return [
        `Open ${webUrl} in Chrome, Edge or Firefox.`,
        'Sign in with your work Google account, click Turn on notifications and choose Allow, then click Send test.',
        'Notifications arrive while the browser is running. Firefox cannot install the app, but notifications still work.',
      ];
  }
}

export function setupInstructions(webUrl: string, platform?: SetupPlatform): string {
  const guide = `${webUrl}/install`;
  const section = (p: SetupPlatform) => `${LABELS[p]}:\n${steps(p, webUrl).map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  const intro =
    'To receive notifications from agents and workflows, set up Agent Notifications on each device where you want them. ' +
    `Step-by-step instructions with pictures for every device: ${guide}`;
  return platform ? `${intro}\n\n${section(platform)}` : `${intro}\n\n${PLATFORMS.map(section).join('\n\n')}`;
}

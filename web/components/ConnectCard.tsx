'use client';

import { CopyField } from './CopyField';
import { API_URL, GEMINI_ENTERPRISE_REDIRECT_URI } from '@/lib/firebase';

export function ConnectCard() {
  return (
    <div className="card">
      <h2>Connect Gemini Enterprise</h2>
      <p className="muted small">
        Register this server as a custom MCP server in Gemini Enterprise (Google Cloud console → Gemini Enterprise → Data stores → Create data store → Custom
        MCP server). Use these values; the client ID and secret are the ones set on the server.
      </p>
      <dl className="kv">
        <CopyField label="MCP server URL" value={`${API_URL}/mcp`} />
        <CopyField label="Authorization URL" value={`${API_URL}/oauth/authorize`} />
        <CopyField label="Token URL" value={`${API_URL}/oauth/token`} />
        <CopyField label="Scopes" value="notifications" />
        <CopyField label="Redirect URI (fixed by Google)" value={GEMINI_ENTERPRISE_REDIRECT_URI} />
      </dl>
      <p className="muted small">
        When Gemini Enterprise first uses the tool it sends you to this app to approve the connection. After that, agents and workflows can call{' '}
        <code>send_notification</code>, and each call shows up here and on your desktop.
      </p>
    </div>
  );
}

'use client';

import { useState } from 'react';

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <span className="copy">
          <code>{value}</code>
          <button
            className="link small"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                // Clipboard unavailable; the value is still visible to select.
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </dd>
    </>
  );
}

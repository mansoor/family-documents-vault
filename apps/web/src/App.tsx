import type { Capabilities } from '@fdv/shared';
import { useEffect, useState } from 'react';
import { ApiRequestError, fetchCapabilities } from './api.js';

type Connection =
  | { state: 'connecting' }
  | { state: 'connected'; capabilities: Capabilities }
  | { state: 'failed'; message: string };

export function App() {
  const [conn, setConn] = useState<Connection>({ state: 'connecting' });

  useEffect(() => {
    let cancelled = false;
    fetchCapabilities()
      .then((capabilities) => {
        if (!cancelled) setConn({ state: 'connected', capabilities });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiRequestError
            ? err.message
            : "We can't reach the vault right now. Check that it is running, then reload.";
        setConn({ state: 'failed', message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const title =
    conn.state === 'connected' ? conn.capabilities.branding.display_name : 'Family Document Vault';

  return (
    <main className="page">
      <div className="logo" aria-hidden="true">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6z" />
        </svg>
      </div>

      <div>
        <h1 style={{ fontSize: 36 }}>{title}</h1>
        <p className="lede">
          Every important paper, in one place. Scanned once, found in seconds, and never quietly
          expired.
        </p>
      </div>

      <section className="card" aria-live="polite">
        <ConnectionStatus conn={conn} />
      </section>
    </main>
  );
}

function ConnectionStatus({ conn }: { conn: Connection }) {
  switch (conn.state) {
    case 'connecting':
      return <span className="status status-warn">Connecting to the vault…</span>;
    case 'failed':
      return (
        <>
          <span className="status status-danger">Not connected</span>
          <p className="muted">{conn.message}</p>
        </>
      );
    case 'connected': {
      const c = conn.capabilities;
      return (
        <>
          <span className="status status-ok">Connected</span>
          <p className="muted">
            Server {c.server_version} · API v{c.api_version} ·{' '}
            {c.edition === 'self_hosted' ? 'self-hosted' : 'hosted'}
          </p>
          <p className="muted">
            Nothing to see yet. The first-run wizard arrives in a later release.
          </p>
        </>
      );
    }
  }
}

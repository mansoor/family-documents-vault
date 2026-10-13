import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DevicePairingCode, DevicePlatform, PairedDevice } from '@fdv/shared';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { storedRole } from '../session.js';
import { Button, ConfirmDialog, ErrorNote, LoadFailed, useSheetFocus } from '../ui.js';
import { SettingsPage } from './Settings.js';

/**
 * Your computers (/settings/computers, 0.8.0 D1): a computer of the
 * person's own that sends the scans it saves straight into their uploads,
 * with the Family Documents Vault uploader. Pairing asks for the password
 * again, then shows a one-time code for 10 minutes; the app on the computer
 * trades it for a key that can only send. Their computers are listed here,
 * each removable; an owner also sees everybody's, by name and person, and
 * can remove any — never anything one sent.
 */

const PLATFORM: Record<DevicePlatform, string> = {
  windows: 'Windows',
  macos: 'Mac',
  linux: 'Linux',
  other: 'A computer',
};

/** A day as the list says it: "13 Oct 2026". */
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The address the app is to be told: the vault's own, unless it names this
 * computer (FDV_BASE_URL left at localhost) while the page is open
 * somewhere else — then where the page is, which the computer can reach.
 */
export function addressToType(vaultAddress: string, here: string = window.location.origin) {
  const local = (u: string) => {
    try {
      return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  return local(vaultAddress) && !local(here) ? here : vaultAddress;
}

export function ComputersScreen() {
  const { guarded, withToken, authVersion } = useApp();
  const owner = storedRole() === 'owner';
  const {
    data,
    error: loadError,
    reload,
  } = useLoad(async (t) => (await api.listDevices(t)).items, [authVersion]);
  const [pairing, setPairing] = useState<DevicePairingCode | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PairedDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const add = async () => {
    setAsking(true);
    setError(null);
    setSaid(null);
    try {
      const made = await guarded((t) => api.createDevicePairing(t));
      if (made) setPairing(made);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAsking(false);
    }
  };

  const remove = async (d: PairedDevice) => {
    setBusy(true);
    setError(null);
    try {
      await guarded((t) => api.revokeDevice(t, d.id));
      setSaid(
        d.mine
          ? `“${d.name}” was removed. It can no longer send scans.`
          : `${d.member_name}’s computer “${d.name}” was removed. It can no longer send scans.`,
      );
      await reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const mine = (data ?? []).filter((d) => d.mine);
  const others = (data ?? []).filter((d) => !d.mine);
  return (
    <SettingsPage title="Your computers">
      <p className="lede">
        A computer of yours can send what you scan to a folder on it straight into your uploads,
        with the Family Documents Vault uploader. It can only send: it cannot open, list or download
        anything in the vault.
      </p>
      <div className="row">
        <Button ref={addButton} onClick={() => void add()} disabled={asking}>
          {asking ? 'Making a code…' : 'Add a computer'}
        </Button>
      </div>
      <ErrorNote message={error} />
      {said && (
        <p className="status status-ok" role="status">
          {said}
        </p>
      )}
      {data === null && loadError ? (
        <LoadFailed message={loadError} what="your computers" onRetry={() => void reload()} />
      ) : (
        <>
          <section aria-labelledby="computers-mine-h">
            <h2 id="computers-mine-h" className="section-h">
              Paired with your sign-in
            </h2>
            <ul className="list">
              {mine.map((d) => (
                <li key={d.id}>
                  <span>
                    <strong>{d.name}</strong>
                    <span className="muted">
                      {PLATFORM[d.platform] ?? 'A computer'} · added {day(d.added_at)}
                      {d.last_used_at
                        ? ` · last sent ${day(d.last_used_at)}`
                        : ' · nothing sent yet'}
                    </span>
                  </span>
                  <Button
                    kind="quiet"
                    ariaLabel={`Remove ${d.name}`}
                    onClick={() => setRemoving(d)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {data !== null && mine.length === 0 && <li className="muted">None yet.</li>}
            </ul>
          </section>
          {owner && others.length > 0 && (
            <section aria-labelledby="computers-others-h">
              <h2 id="computers-others-h" className="section-h">
                Everybody else’s
              </h2>
              <p className="muted">
                Computers the family has paired, by name. You never see what they send: that is each
                person’s own until they accept it.
              </p>
              <ul className="list">
                {others.map((d) => (
                  <li key={d.id}>
                    <span>
                      <strong>{d.name}</strong>
                      <span className="muted">
                        {d.member_name} · {PLATFORM[d.platform] ?? 'A computer'} · added{' '}
                        {day(d.added_at)}
                      </span>
                    </span>
                    <Button
                      kind="quiet"
                      ariaLabel={`Remove ${d.member_name}’s ${d.name}`}
                      onClick={() => setRemoving(d)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {pairing && (
        <PairingDialog
          pairing={pairing}
          known={new Set((data ?? []).map((d) => d.id))}
          returnFocus={addButton}
          onNew={() => void add()}
          onClose={() => {
            setPairing(null);
            // A code nobody used is ended as its dialog closes (the D1
            // review, F8): it is not left to work for the rest of its minutes.
            void withToken((t) => api.endDevicePairing(t))
              .catch(() => undefined)
              .then(() => reload());
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove “${removing.name}”?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          busy={busy}
          returnFocus={addButton}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        >
          <p>
            {removing.mine
              ? 'It can no longer send scans. To use it again, pair it again.'
              : `${removing.member_name} is not told before it stops; they can pair it again.`}
          </p>
        </ConfirmDialog>
      )}
    </SettingsPage>
  );
}

/** "9:41": minutes and seconds left. */
function left(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The code, shown once and large, with the address to type before it and a
 * countdown; where the uploader comes from. Asks the vault every few
 * seconds whether a computer has been paired, and says so when one has.
 */
function PairingDialog(props: {
  pairing: DevicePairingCode;
  /** The computers listed when it opened: a new one is the one just paired. */
  known: Set<string>;
  returnFocus: RefObject<HTMLElement | null>;
  onNew: () => void;
  onClose: () => void;
}) {
  const { withToken } = useApp();
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const codeBox = useRef<HTMLSpanElement>(null);
  /** Make a new code was pressed: focus goes to the new code, not to nowhere. */
  const renewing = useRef(false);
  useSheetFocus(box, { start: heading, onEscape: props.onClose, returnFocus: props.returnFocus });
  useEffect(() => {
    if (!renewing.current) return;
    renewing.current = false;
    codeBox.current?.focus();
  }, [props.pairing]);
  const ends = Date.parse(props.pairing.expires_at);
  const [now, setNow] = useState(() => Date.now());
  const [paired, setPaired] = useState<PairedDevice | null>(null);
  const known = useRef(props.known);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ran = now >= ends;
  useEffect(() => {
    if (paired || ran) return;
    const t = setInterval(() => {
      void withToken((tk) => api.listDevices(tk))
        .then((r) => {
          const fresh = r?.items.find((d) => d.mine && !known.current.has(d.id));
          if (fresh) setPaired(fresh);
        })
        .catch(() => undefined);
    }, 4000);
    return () => clearInterval(t);
  }, [paired, ran, withToken]);
  const address = addressToType(props.pairing.vault_address);
  const code = props.pairing.code;
  return (
    <div className="scrim" role="presentation">
      <section
        ref={box}
        className="card stack sheet pairing-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-h"
      >
        <h2 id="pairing-h" ref={heading} tabIndex={-1} style={{ fontSize: 20 }}>
          Add a computer
        </h2>
        {paired ? (
          <p className="status status-ok" role="status">
            {`“${paired.name}” is paired. What it sends arrives in your uploads, a batch a day.`}
          </p>
        ) : (
          <>
            <ol className="pairing-steps">
              <li>
                {props.pairing.download_url ? (
                  <>
                    On the computer,{' '}
                    <a href={props.pairing.download_url} target="_blank" rel="noreferrer">
                      download the Family Documents Vault uploader
                    </a>{' '}
                    and open it.
                  </>
                ) : (
                  <>Ask whoever runs your vault for the Family Documents Vault uploader.</>
                )}
              </li>
              <li>
                Type this address into it:
                <code className="pairing-address">{address}</code>
              </li>
              <li>
                Then this code:
                <span ref={codeBox} tabIndex={-1} className="pairing-code-box">
                  {/* Read a character at a time; the large code itself is for the eye. */}
                  <span className="visually-hidden">
                    {`Code: ${code.replace('-', '').split('').join(' ')}`}
                  </span>
                  <span
                    aria-hidden="true"
                    className={ran ? 'pairing-code pairing-code-ran' : 'pairing-code'}
                  >
                    {code}
                  </span>
                </span>
              </li>
            </ol>
            {ran ? (
              <p className="status status-warn" role="alert">
                This code has run out. Make a new one.
              </p>
            ) : (
              <p className="muted pairing-left">
                Works once, for <span className="pairing-time">{left(ends - now)}</span> more. It is
                shown only here: once you close this, it cannot be seen again.
              </p>
            )}
          </>
        )}
        <div className="row">
          {ran && !paired && (
            <Button
              onClick={() => {
                renewing.current = true;
                props.onNew();
              }}
            >
              Make a new code
            </Button>
          )}
          <Button kind={ran || paired ? 'quiet' : 'primary'} onClick={props.onClose}>
            {paired ? 'Done' : 'Close'}
          </Button>
        </div>
      </section>
    </div>
  );
}

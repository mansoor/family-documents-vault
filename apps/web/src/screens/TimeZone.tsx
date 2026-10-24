import {
  canonicalZone,
  sameZone,
  refusalFor,
  timeZoneNames,
  zonedParts,
  zoneOffsetWords,
  type FamilyTimeZone,
} from '@fdv/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from '../api.js';
import { describeError, useApp, useLoad } from '../app-context.js';
import { browserZone } from '../family-time.js';
import { Button, LoadFailed } from '../ui.js';
import { SettingsPage } from './Settings.js';

/**
 * Settings → Time zone (/settings/time-zone; 0.9.0, TZ, the owner's ask of
 * 23 Oct 2026): the family's clock. Every time the vault shows is on it,
 * for everybody in the family, whatever zone their browser is in; the hour
 * reminders and digests arrive at is on it; and a link's end is chosen and
 * said on it. An owner chooses it — from every zone this browser knows, found
 * by name or offset — or takes this browser's in one go, or goes back to the
 * server's default (FDV_TIMEZONE in the .env, else UTC). Everyone else reads
 * it here.
 */
export function TimeZoneScreen() {
  const { authVersion, withToken, setFamilyZone } = useApp();
  const { data, error, setData, reload } = useLoad((t) => api.householdTimezone(t), [authVersion]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const problemAt = useRef<HTMLParagraphElement>(null);

  const change = async (to: string | null) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      const next = await withToken((t) => api.setHouseholdTimezone(t, to));
      if (!next) return;
      flushSync(() => {
        setData(next);
        setSaid(savedWords(next));
      });
      // Every screen moves to it at once.
      setFamilyZone(next.timezone);
      status.current?.focus();
    } catch (err) {
      flushSync(() => setProblem(describeError(err)));
      problemAt.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title="Time zone">
      <section className="card stack" aria-labelledby="tz-h">
        <h2 id="tz-h" style={{ fontSize: 18 }}>
          The family’s time zone
        </h2>
        {data === null && error ? (
          <LoadFailed message={error} what="the time zone" onRetry={() => void reload()} />
        ) : data === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <dl className="facts">
              <dt>Now</dt>
              <dd>
                <ZoneWords zone={data.timezone} />
              </dd>
              <dt>Chosen by</dt>
              <dd>
                {data.timezone_source === 'household'
                  ? 'An owner, for the family'
                  : `The server’s default (FDV_TIMEZONE: ${data.server_timezone})`}
              </dd>
            </dl>
            <p className="muted" id="tz-affects">
              Every time the vault shows is on this clock, for everyone in the family, wherever they
              are. Reminders and digests arrive at their hour on it, and share links end on it.
              Dates without a time, like an expiry or a birthday, never move.
            </p>
            {data.can_change ? (
              <ZoneChooser data={data} busy={busy} onChoose={(to) => void change(to)} />
            ) : (
              <p className="muted">{refusalFor('household.timezone')}</p>
            )}
            <p ref={problemAt} className="error" role="alert" tabIndex={-1} hidden={!problem}>
              {problem}
            </p>
          </>
        )}
        <p ref={status} className="notice status-line" role="status" tabIndex={-1}>
          {said}
        </p>
      </section>
    </SettingsPage>
  );
}

/** "Europe/London, GMT+1, 14:05 now". */
export function zoneLine(zone: string, now: Date = new Date()): string {
  return `${zone}, ${zoneOffsetWords(zone, now)}, ${zonedParts(now, zone).time} now`;
}

/** A zone's line, broken after its name rather than inside "GMT+1, 14:05 now". */
function ZoneWords({ zone, now }: { zone: string; now?: Date }) {
  const at = now ?? new Date();
  return (
    <>
      <span className="tz-name">{zone}</span>
      {/* Heard as one line; seen as two, the zone's name never broken from its comma. */}
      <span className="visually-hidden">, </span>
      <span className="tz-now">{`${zoneOffsetWords(zone, at)}, ${zonedParts(at, zone).time} now`}</span>
    </>
  );
}

/** "Saved. Times are now shown on Europe/London." */
export function savedWords(next: FamilyTimeZone): string {
  return next.timezone_source === 'household'
    ? `Saved. Times are now shown on ${next.timezone}.`
    : `Saved. The family uses the server’s default again: ${next.timezone}.`;
}

/**
 * An owner's choice: a zone found by name or offset, from every one this
 * browser knows; this browser's own in one go, when it is another; and the
 * server's default again, when the family has its own.
 */
function ZoneChooser(props: {
  data: FamilyTimeZone;
  busy: boolean;
  onChoose: (zone: string | null) => void;
}) {
  const { data, busy } = props;
  const [find, setFind] = useState('');
  const [chosen, setChosen] = useState(data.timezone);
  // As the vault spells it, to compare with the zone in use (the TZ review).
  const here = canonicalZone(browserZone()) ?? browserZone();
  // Asked once a visit: the offsets and the time now are as the page opened.
  const [now] = useState(() => new Date());
  const all = useMemo(
    () =>
      timeZoneNames([data.timezone, data.server_timezone, here]).map((zone) => ({
        zone,
        line: zoneLine(zone, now),
      })),
    [data.timezone, data.server_timezone, here, now],
  );
  const words = find.trim().toLowerCase().replace(/\s+/g, '_');
  const shown = words
    ? all.filter(
        (z) =>
          z.line.toLowerCase().replace(/\s+/g, '_').includes(words) ||
          z.line.toLowerCase().includes(find.trim().toLowerCase()),
      )
    : all;
  // The one chosen stays in the list, whatever is typed.
  const listed = shown.some((z) => z.zone === chosen)
    ? shown
    : [...all.filter((z) => z.zone === chosen), ...shown];
  // The zone in use, in sight in its list as the page opens (never the page scrolled for it).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = list.current;
    const on = box?.querySelector<HTMLElement>('input:checked')?.closest('label');
    if (box && on) box.scrollTop = Math.max(0, on.offsetTop - 8); // the list holds its rows (position: relative)
  }, []);

  return (
    <div className="stack">
      {!sameZone(here, data.timezone) && (
        <div className="stack">
          <Button kind="quiet" disabled={busy} onClick={() => props.onChoose(here)}>
            {`Use this browser’s zone (${here})`}
          </Button>
        </div>
      )}
      {data.timezone_source === 'household' && (
        <div className="stack">
          <Button kind="quiet" disabled={busy} onClick={() => props.onChoose(null)}>
            {`Use the server’s default (FDV_TIMEZONE: ${data.server_timezone})`}
          </Button>
        </div>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          props.onChoose(chosen);
        }}
      >
        <div className="field">
          <label htmlFor="tz-find">Find a time zone</label>
          <input
            id="tz-find"
            type="search"
            value={find}
            autoComplete="off"
            aria-describedby="tz-find-hint"
            onChange={(e) => setFind(e.target.value)}
          />
          <span id="tz-find-hint" className="muted">
            A city or region, like London or New York, or an offset, like GMT+5:30.
          </span>
        </div>
        <fieldset className="plain field">
          <legend className="field-label">Time zone</legend>
          {/* Each a radio, its line wrapping at any width; one stop in the
              tab order, the arrow keys moving along them. */}
          <div className="tz-list" ref={list}>
            {listed.map((z) => (
              <label key={z.zone} className="tz-row">
                <input
                  type="radio"
                  name="tz-pick"
                  value={z.zone}
                  checked={chosen === z.zone}
                  onChange={() => setChosen(z.zone)}
                />
                <span>
                  <ZoneWords zone={z.zone} now={now} />
                </span>
              </label>
            ))}
          </div>
          <span className="muted" role="status">
            {shown.length === 0
              ? 'No time zone has that in its name or offset.'
              : `${shown.length} ${shown.length === 1 ? 'time zone' : 'time zones'}`}
          </span>
        </fieldset>
        <Button
          type="submit"
          disabled={busy || (chosen === data.timezone && data.timezone_source === 'household')}
          describedBy="tz-affects"
        >
          {busy ? 'Saving…' : `Use ${chosen}`}
        </Button>
      </form>
    </div>
  );
}

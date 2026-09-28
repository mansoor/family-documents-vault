import { PREVIEW_MAX_PAGES } from './documents.js';
import { addDays } from './reminders.js';
import { canSee } from './roles.js';

/**
 * A link's options (5.18): until a date and time, to view or to download,
 * and how many times. The rules the vault holds a new link to, and the
 * words every client says them in, in one place.
 */

/** What a link gives: the pages the vault drew for it, or the file itself. */
export type SharePermission = 'view' | 'download';

/** A link must last at least this long: an end in the past, or a moment away, is refused. */
export const SHARE_MIN_MINUTES = 5;
/** And at most this many days, unless the operator shortens it (FDV_SHARE_MAX_DAYS, A20). */
export const SHARE_MAX_DAYS = 90;
/** The most opens or downloads a limit may allow; no limit is no limit. */
export const SHARE_LIMIT_MAX = 1000;

/**
 * The kinds of file the vault can draw pages of, and so share to view: a
 * PDF and the photos it accepts. Word and Excel files are shared only to
 * download (A22).
 */
const DRAWABLE = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

export function canShareToView(mime: string | null | undefined): boolean {
  return mime ? DRAWABLE.has(mime) : false;
}

/** A view-only link's pages: how many will be seen, of how many, and whether they are drawn yet. */
export interface SharePages {
  /** `drawing` until they exist; `ready`; `failed` when the vault could not draw them. */
  state: 'drawing' | 'ready' | 'failed';
  /** How many the recipient sees: at most PREVIEW_MAX_PAGES. Null until known. */
  shown: number | null;
  /** How many the document has, when the vault knows. */
  total: number | null;
}

/** What the sharer is told about a view-only link's pages, or null when there is nothing to say. */
export function sharePagesNote(pages: SharePages | null | undefined): string | null {
  if (!pages) return null;
  if (pages.state === 'failed') {
    return 'The vault could not draw the pages of this document, so the link shows nothing. Take it back, and share it to download instead.';
  }
  const cut =
    pages.total !== null && pages.total > (pages.shown ?? PREVIEW_MAX_PAGES)
      ? `They will see the first ${pages.shown ?? PREVIEW_MAX_PAGES} of ${pages.total} pages.`
      : null;
  if (pages.state === 'drawing') {
    return [cut, 'The pages are still being drawn; the link works in a minute.']
      .filter(Boolean)
      .join(' ');
  }
  return cut;
}

/** What the recipient is told when the document is longer than what was shared. */
export function pagesNotSharedNote(pages: SharePages | null | undefined): string | null {
  if (!pages || pages.shown === null || pages.total === null || pages.total <= pages.shown) {
    return null;
  }
  return `Pages after ${pages.shown} were not shared.`;
}

// ------------------------------------------------ sharing a collection (5.19)

/**
 * A collection's link that keeps up with it — what is put in the
 * collection later goes out too — lasts this many days at most (A19).
 */
export const FOLLOW_MAX_DAYS = 30;

/**
 * Whether every one of a collection's audience may see a document: what a
 * link that follows its collection sends later must be (A19), and what the
 * share sheet ticks for you. A private document never is, and neither is
 * anything in an Only me collection, which is never shared. The database's
 * own copy is collection_audience_sees (0042); a test holds them equal.
 */
export function withinCollectionAudience(audience: string, visibility: string): boolean {
  switch (audience) {
    case 'everyone':
    case 'teens':
      // Owners, adults and teens: what a teen may see.
      return canSee({ role: 'teen', memberId: null }, { visibility, owner_member_id: null });
    case 'adults':
      return canSee({ role: 'adult', memberId: null }, { visibility, owner_member_id: null });
    default:
      return false;
  }
}

/** Why a document in a collection is not ticked for you when you share it. */
export type CollectionShareLock = 'adults' | 'private' | 'no_file';

/** What the share sheet says beside each, and asks. */
export const COLLECTION_SHARE_REASONS: Readonly<Record<CollectionShareLock, string>> = {
  adults: 'Adults only — include anyway?',
  private: 'Only you can see this. It is private.',
  no_file: 'There is no file on this document yet, so there is nothing to send.',
};

/**
 * Whether the share sheet ticks a document for you, and if not why: ticked
 * when everybody the collection is for may see it; an adults-only one in a
 * collection for everybody is asked about; a private one — yours, or you
 * would not be shown it — is never ticked for you; one with no file cannot
 * go at all.
 */
export function collectionShareItem(
  audience: string,
  doc: { visibility: string; has_file: boolean },
): { ticked: boolean; lock: CollectionShareLock | null } {
  if (!doc.has_file) return { ticked: false, lock: 'no_file' };
  if (withinCollectionAudience(audience, doc.visibility)) return { ticked: true, lock: null };
  return { ticked: false, lock: doc.visibility === 'private' ? 'private' : 'adults' };
}

/** The counts on a link, as the family reads them: "Opened 2 of 5 times; 3 downloads". */
export function shareUses(s: {
  open_count: number;
  max_opens?: number | null;
  permission?: SharePermission;
  downloads_used?: number;
  max_downloads?: number | null;
  flow?: 'legacy' | 'v2';
}): string {
  const times = (n: number) => (n === 1 ? 'time' : 'times');
  const opens =
    s.max_opens != null
      ? `Opened ${s.open_count} of ${s.max_opens} ${times(s.max_opens)}`
      : s.open_count === 0
        ? 'Not opened yet'
        : s.open_count === 1
          ? 'Opened once'
          : `Opened ${s.open_count} times`;
  if (s.permission === 'view') return `${opens}; to view only`;
  // A legacy link, or an older vault's, counts no downloads of its own.
  if (s.flow === 'legacy' || s.downloads_used === undefined) return opens;
  const d = s.downloads_used;
  if (s.max_downloads != null) return `${opens}; ${d} of ${s.max_downloads} downloads`;
  if (d === 0) return s.open_count === 0 ? opens : `${opens}; not downloaded yet`;
  return `${opens}; ${d} ${d === 1 ? 'download' : 'downloads'}`;
}

// ------------------------------------------------------ the household's clock

/** A moment's date, time and weekday on the household's clock. */
export interface ZonedParts {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  /** 0 is Sunday, as Date.getDay(). */
  weekday: number;
}

function partsOf(at: Date, timezone: string): Record<string, number> {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timezone);
  } catch {
    parts = fmt('UTC');
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment on the household's clock. */
export function zonedParts(at: Date, timezone: string): ZonedParts {
  const p = partsOf(at, timezone);
  const date = `${p.year}-${pad(p.month ?? 1)}-${pad(p.day ?? 1)}`;
  return {
    date,
    time: `${pad(p.hour ?? 0)}:${pad(p.minute ?? 0)}`,
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
  };
}

/** How far the household's clock is ahead of UTC at a moment, in minutes. */
function offsetMinutes(at: Date, timezone: string): number {
  const p = partsOf(at, timezone);
  const wall = Date.UTC(
    p.year ?? 1970,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The moment a date and a time on the household's clock name: "Friday at
 * 17:00" in Europe/London is 16:00 UTC in summer and 17:00 in winter.
 * Null when either is not one.
 */
export function zonedTime(date: string, time: string, timezone: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (Number.isNaN(wall)) return null;
  // Twice: the offset at the first guess can differ from the one at the
  // answer, around a change of the clocks.
  let at = wall - offsetMinutes(new Date(wall), timezone) * 60_000;
  at = wall - offsetMinutes(new Date(at), timezone) * 60_000;
  return new Date(at);
}

/** The quick picks for a link's end: Tonight, Friday 5 pm, In a week. */
export interface ShareQuickPick {
  key: 'tonight' | 'friday' | 'week';
  label: string;
  at: Date;
}

/**
 * Tonight is 11 pm today, while there is time before it; Friday 5 pm is
 * this Friday's, or next week's once this one has gone by; In a week is
 * this time next week. All on the household's clock, and only those within
 * the vault's longest (`maxDays`, the capability document's
 * `limits.share_max_days`).
 */
export function shareQuickPicks(
  timezone: string,
  now = new Date(),
  maxDays = SHARE_MAX_DAYS,
): ShareQuickPick[] {
  return quickPicks(timezone, now).filter((p) => p.at.getTime() <= now.getTime() + maxDays * 864e5);
}

/** The longest end the vault takes, on the household's clock, to the minute below it. */
export function latestShareEnd(timezone: string, now = new Date(), maxDays = SHARE_MAX_DAYS) {
  return zonedParts(new Date(now.getTime() + maxDays * 864e5), timezone);
}

/**
 * The end a new link starts with: In a week, or — where a week is at, or
 * past, the vault's longest (`maxDays` of 7 or less) — its longest, brought
 * safely inside it: a quarter of an hour back, down to the hour on the
 * household's clock, and back an hour more while that is still refused. So
 * neither a clock a few minutes out nor the night the clocks go back (when
 * 01:30 happens twice) puts it past the limit.
 */
export function defaultShareEnd(
  timezone: string,
  now = new Date(),
  maxDays = SHARE_MAX_DAYS,
): { date: string; time: string } {
  const limit = now.getTime() + maxDays * 864e5;
  const week = shareQuickPicks(timezone, now, maxDays).find((p) => p.key === 'week');
  // A week, only while it is a quarter of an hour or more inside the
  // longest: at exactly seven days it is the very edge (the third review).
  if (week && week.at.getTime() <= limit - 15 * 60_000) {
    const { date, time } = zonedParts(week.at, timezone);
    return { date, time };
  }
  for (let back = 0; back < 6; back += 1) {
    const { date, time } = zonedParts(new Date(limit - 15 * 60_000 - back * 3_600_000), timezone);
    const hour = `${time.slice(0, 2)}:00`;
    const at = zonedTime(date, hour, timezone);
    if (at && at.getTime() <= limit - 5 * 60_000 && !shareEndProblem(at, { now, maxDays })) {
      return { date, time: hour };
    }
  }
  const { date, time } = zonedParts(new Date(limit - 6 * 3_600_000), timezone);
  return { date, time };
}

/**
 * How far past its longest the vault still takes an end, for a client whose
 * clock is a few minutes out: the web offers nothing past the longest, and
 * the vault does not refuse what it offered.
 */
export const SHARE_END_GRACE_MINUTES = 5;

function quickPicks(timezone: string, now: Date): ShareQuickPick[] {
  const soonest = now.getTime() + SHARE_MIN_MINUTES * 60_000;
  const today = zonedParts(now, timezone);
  const picks: ShareQuickPick[] = [];
  const tonight = zonedTime(today.date, '23:00', timezone);
  if (tonight && tonight.getTime() >= soonest) {
    picks.push({ key: 'tonight', label: 'Tonight', at: tonight });
  }
  for (let add = 0; add <= 7; add += 1) {
    if ((today.weekday + add) % 7 !== 5) continue;
    const friday = zonedTime(addDays(today.date, add), '17:00', timezone);
    if (friday && friday.getTime() >= soonest) {
      picks.push({ key: 'friday', label: 'Friday 5 pm', at: friday });
      break;
    }
  }
  const week = zonedTime(addDays(today.date, 7), today.time, timezone);
  if (week) picks.push({ key: 'week', label: 'In a week', at: week });
  return picks;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Friday 3 October at 17:00", on the household's clock. */
export function shareEndWords(
  at: Date,
  timezone: string,
  opts: { weekday?: boolean } = {},
): string {
  const p = zonedParts(at, timezone);
  const [, month = 1, day = 1] = p.date.split('-').map(Number);
  const onDay = `${day} ${MONTHS[month - 1] ?? ''}`;
  return `${opts.weekday === false ? '' : `${WEEKDAYS[p.weekday] ?? ''} `}${onDay} at ${p.time}`;
}

/**
 * Why an end is refused, in the words the vault answers with; null when it
 * is fine. `graceMinutes` past the longest are let through (the vault's
 * SHARE_END_GRACE_MINUTES); a client checks with none.
 */
export function shareEndProblem(
  at: Date,
  opts: { now?: Date; maxDays?: number; graceMinutes?: number } = {},
): string | null {
  const now = (opts.now ?? new Date()).getTime();
  const maxDays = opts.maxDays ?? SHARE_MAX_DAYS;
  if (Number.isNaN(at.getTime())) return 'That is not a date and time.';
  if (at.getTime() < now + SHARE_MIN_MINUTES * 60_000) {
    return `Choose a time at least ${SHARE_MIN_MINUTES} minutes from now.`;
  }
  if (at.getTime() > now + maxDays * 864e5 + (opts.graceMinutes ?? 0) * 60_000) {
    return `A link can last ${maxDays} days at most.`;
  }
  return null;
}

// ---------------------------------------------- a second factor (5.20)

/**
 * What a link may ask for besides itself (5.20), in any combination: a PIN
 * or a password, an emailed code, and to open in one browser only. A PIN is
 * four digits the vault makes up; a password is one it makes up, or one the
 * sharer types.
 */
export type ShareSecretKind = 'pin' | 'password';

/** A typed password: at least this long, and at most SHARE_PASSWORD_MAX. */
export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 64;

/** An emailed code: six digits, good for 10 minutes and 5 tries, and used once. */
export const SHARE_CODE_DIGITS = 6;
export const SHARE_CODE_MINUTES = 10;
export const SHARE_CODE_TRIES = 5;
/** At most 3 codes a link in any 15 minutes, and 10 in a day. */
export const SHARE_CODE_SENDS = { perWindow: 3, windowMinutes: 15, perDay: 10 } as const;

/**
 * What the share sheet says of an emailed code, beside the box: what it
 * proves, and what it does not.
 */
export const SHARE_CODE_TRUTH =
  'The code proves they can read that inbox. It protects against a forwarded or misposted link, not a hacked mailbox.';

/**
 * Why a vault without the operator's mail server offers no emailed code
 * (A21): the household's own mail settings are an owner's to point
 * anywhere, and a code read by somebody else opens the link.
 */
export const SHARE_CODE_UNAVAILABLE =
  'Emailing a code needs the mail server of whoever runs this vault, and none is set up. The household’s own mail settings are not used for it: a code must not go through a server that can be pointed anywhere.';

/**
 * An address as the recipient and the activity log see it: enough to know
 * which inbox, and no more — `jane.smith@example.com` is `j•••@e•••.com`.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.charAt(0)}•••@${name.charAt(0)}•••${tld}`;
}

/**
 * A code as somebody typed it, or null when it cannot be one: six digits,
 * with any spaces or dashes between them (`123 456`) taken out.
 */
export function readShareCode(typed: string | null | undefined): string | null {
  const digits = (typed ?? '').replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${SHARE_CODE_DIGITS}}$`).test(digits) ? digits : null;
}

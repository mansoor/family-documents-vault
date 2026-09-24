import type { Status } from './documents.js';

/**
 * The design, written once: every colour, radius, size and label that the
 * web app and the phone app both draw with. Taken from the prototype's
 * layout and colour roles, with the web's accessible sizes (16px body,
 * 44px targets) — the prototype's own sizes are below the project's
 * accessibility floor (NFR-09).
 *
 * The web's stylesheet holds the same values as custom properties; a test
 * there fails if the two ever disagree. `tokens.test.ts` here fails if any
 * text colour drops below WCAG AA on the background it is drawn on.
 */

export const colours = {
  bg: '#FAF8F4',
  surface: '#FFFFFF',
  border: '#E6E0D6',
  borderStrong: '#DDD6C9',
  // What marks out a text box or a select. `border` is 1.3:1, too faint
  // for a control's edge (WCAG 1.4.11 asks 3:1); this is at least 3.5:1.
  borderInput: '#8A8275',
  ink: '#1C1A17',
  inkSoft: '#3C362F',
  inkMuted: '#5E574E',
  accent: '#1F5D4C',
  accentSoft: '#E9F0EC',
  ok: '#1F5D4C',
  // The web used #B7791F until 0.4.4: 3.64:1 on white, which fails AA.
  warn: '#8A4B08',
  warnSoft: '#FDF3E7',
  danger: '#962D2D',
  dangerSoft: '#FBEAEA',
  highlight: '#F3EAD0',
  onAccent: '#FFFFFF',
  /** Ink at 45%: behind a sheet, so the page still shows through. */
  scrim: '#1C1A1773',
  /** Accent at 35%: the shadow under the add button. */
  accentGlow: '#1F5D4C59',
} as const;

export type ColourRole = keyof typeof colours;

export const radii = { s: 10, m: 12, l: 14, xl: 17, card: 16, pill: 999 } as const;

/** A 4-based scale; every spacing value the prototype uses is on it. */
export const space = [0, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32] as const;

export const type = {
  body: 16,
  secondary: 14,
  small: 12,
  display: { title: 26, screen: 24, hero: 32 },
  families: {
    body: 'Figtree',
    display: 'Fraunces',
  },
} as const;

/** The minimum touch target, in CSS pixels or density-independent points. */
export const TAP_MIN = 44;

/**
 * A member's colour, by the index the server stores on them, so a person
 * is the same colour on every screen of every app. White initials must
 * read on every one (tested).
 */
export const AVATAR = [
  '#1F5D4C',
  '#8A4B08',
  '#4A5FA8',
  '#962D2D',
  '#6B4FA0',
  '#2A7F8F',
  '#7A5D2F',
  '#5E574E',
] as const;

export function avatarColour(index: number): string {
  return AVATAR[((index % AVATAR.length) + AVATAR.length) % AVATAR.length] as string;
}

export const CATEGORY_LABELS: Record<string, string> = {
  identity: 'Identity',
  legal: 'Legal',
  property: 'Property & vehicle',
  financial: 'Financial',
  tax: 'Tax',
  insurance: 'Insurance',
  medical: 'Medical',
  education: 'Education',
  bills: 'Bills & utilities',
  work: 'Work',
  pets: 'Pets',
  other: 'Other',
};

export const categoryLabel = (c: string | null): string =>
  c ? (CATEGORY_LABELS[c] ?? c) : 'Unsorted';

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

/**
 * How a status is drawn: a tone, an icon name and the words. Never the
 * colour alone (NFR-09) — a screen reader, or somebody who cannot tell
 * amber from green, gets the same meaning from the word and the icon.
 * `null` for a document that needs nothing said about it.
 */
export function statusTone(
  status: Status,
): { tone: Tone; icon: 'check' | 'clock' | 'alert' | 'info'; words: string } | null {
  switch (status.value) {
    case 'valid':
      return null;
    case 'expired':
      return { tone: 'danger', icon: 'alert', words: status.label };
    case 'expiring_soon':
      return { tone: 'warn', icon: 'clock', words: status.label };
    case 'needs_info':
      return { tone: 'warn', icon: 'info', words: status.label };
    case 'active':
      return { tone: 'ok', icon: 'check', words: status.label };
    default:
      // A value this client has never heard of is shown as its words,
      // plainly (API-02: unknown enum values are opaque).
      return { tone: 'neutral', icon: 'info', words: status.label };
  }
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const channel = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

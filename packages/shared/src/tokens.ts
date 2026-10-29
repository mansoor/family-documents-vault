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
  /** Words and marks drawn on the accent: a primary button's, a count's, the logo's. */
  onAccent: '#FFFFFF',
  /** Ink at 45%: behind a sheet, so the page still shows through. */
  scrim: '#1C1A1773',
  /** Accent at 35%: the shadow under the add button. */
  accentGlow: '#1F5D4C59',
  /** A menu, a sheet or a dialog, above the page: the surface itself in light. */
  raised: '#FFFFFF',
  /**
   * A page's own white, in either theme: behind a scan, a preview and the
   * QR code (a transparent PNG must never vanish into a dark page), and the
   * initials on a member's colour. Never filtered, never inverted.
   */
  paper: '#FFFFFF',
  /** A switch's knob while it is off. */
  knob: '#FFFFFF',
} as const;

export type ColourRole = keyof typeof colours;

/**
 * The soft dark theme (0.9.0, the owner's ask of 27 Oct 2026): a slate-blue
 * page, cards a little lighter, soft light text, the brand's green lightened
 * to be the accent, and warm warning and error tints — never black, never
 * a developer's dark. Every role the light theme has, with the same job;
 * the same pairs pass WCAG AA (tokens.test.ts).
 */
export const darkColours = {
  bg: '#1E2633',
  surface: '#263142',
  border: '#3A4759',
  borderStrong: '#46546A',
  borderInput: '#8695AB',
  ink: '#E8EDF4',
  inkSoft: '#C9D2DE',
  inkMuted: '#A3AFC0',
  accent: '#6DB89E',
  accentSoft: '#22413A',
  ok: '#6DB89E',
  warn: '#F0B46B',
  warnSoft: '#3B2F1F',
  danger: '#F2A0A0',
  dangerSoft: '#42282B',
  highlight: '#4A4128',
  onAccent: '#0F2620',
  /** A deep slate at 70%: a sheet must still stand off a dark page. */
  scrim: '#0B0F16B3',
  accentGlow: '#6DB89E59',
  raised: '#2D3A4E',
  paper: '#FFFFFF',
  knob: '#E8EDF4',
} as const satisfies Record<ColourRole, string>;

/** The two themes, by the name the web's `data-theme` gives them. */
export const themes = { light: colours, dark: darkColours } as const;

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
    // Kept, and nothing to act on (0.9.0): said plainly, never in warning.
    case 'no_longer_needed':
      return { tone: 'neutral', icon: 'info', words: status.label };
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

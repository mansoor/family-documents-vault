import { describe, expect, it } from 'vitest';
import type { StatusValue } from './documents.js';
import {
  AVATAR,
  avatarColour,
  colours,
  contrast,
  darkColours,
  luminance,
  statusTone,
  themes,
  type ColourRole,
} from './tokens.js';

/** WCAG 2.2 AA for body text (NFR-09). */
const AA = 4.5;
/** WCAG 2.2 AA for what marks out a control, and for a focus ring (1.4.11). */
const NON_TEXT = 3;

/** Every text colour, on each background it is drawn on. */
const TEXT: Array<[ColourRole, ColourRole]> = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink', 'raised'],
  ['inkSoft', 'bg'],
  ['inkSoft', 'surface'],
  ['inkSoft', 'raised'],
  ['inkMuted', 'bg'],
  ['inkMuted', 'surface'],
  ['inkMuted', 'raised'],
  ['inkMuted', 'accentSoft'],
  ['inkMuted', 'warnSoft'],
  ['inkMuted', 'dangerSoft'],
  ['inkMuted', 'highlight'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accent', 'raised'],
  ['accent', 'accentSoft'],
  ['ok', 'surface'],
  ['warn', 'bg'],
  ['warn', 'surface'],
  ['warn', 'raised'],
  ['warn', 'warnSoft'],
  ['danger', 'bg'],
  ['danger', 'surface'],
  ['danger', 'raised'],
  ['danger', 'dangerSoft'],
  ['onAccent', 'accent'],
  ['ink', 'highlight'],
  ['ink', 'accentSoft'],
  ['ink', 'warnSoft'],
  ['ink', 'dangerSoft'],
  // Turned about: a tooltip, a toast, the bar over chosen documents.
  ['surface', 'ink'],
  // A danger button's words.
  ['surface', 'danger'],
];

describe.each([
  ['light', colours],
  ['dark', darkColours],
] as const)('the design tokens, %s', (theme, c) => {
  it('every text colour meets AA on each background it is drawn on', () => {
    for (const [text, background] of TEXT) {
      const ratio = contrast(c[text], c[background]);
      expect(
        ratio,
        `${theme}: ${text} on ${background}: ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('a text box or select, and a focus ring, show against every background they sit on', () => {
    for (const background of ['surface', 'bg', 'raised'] as const) {
      const edge = contrast(c.borderInput, c[background]);
      expect(edge, `${theme}: borderInput on ${background}`).toBeGreaterThanOrEqual(NON_TEXT);
      // A ring is drawn in the accent or in ink.
      for (const ring of ['accent', 'ink'] as const) {
        const ratio = contrast(c[ring], c[background]);
        expect(ratio, `${theme}: ${ring} ring on ${background}`).toBeGreaterThanOrEqual(NON_TEXT);
      }
    }
    // The plain border is for cards and dividers, which need not stand out.
    expect(contrast(c.border, c.surface)).toBeLessThan(NON_TEXT);
  });

  it('a switch’s knob shows against its track, off and on', () => {
    // Off: as plain as light's white on its beige, or plainer.
    expect(contrast(c.knob, c.border)).toBeGreaterThanOrEqual(
      contrast(colours.knob, colours.border),
    );
    // On: the knob in the accent's own ink.
    expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it('the glow is the accent, translucent; the scrim translucent', () => {
    expect(c.accentGlow.slice(0, 7)).toBe(c.accent);
    expect(c.accentGlow).toHaveLength(9);
    expect(c.scrim).toHaveLength(9);
  });

  it('paper is white: a scan is shown on it as it is', () => {
    expect(c.paper).toBe('#FFFFFF');
  });
});

describe('the two themes', () => {
  it('have the same roles', () => {
    expect(Object.keys(darkColours).sort()).toEqual(Object.keys(colours).sort());
    expect(themes.light).toBe(colours);
    expect(themes.dark).toBe(darkColours);
  });

  it('dark is soft, not black: no background below a slate, and no glaring white ink', () => {
    for (const role of ['bg', 'surface', 'raised'] as const) {
      expect(luminance(darkColours[role]), role).toBeGreaterThan(luminance('#141A24'));
    }
    expect(darkColours.ink).not.toBe('#FFFFFF');
  });

  it('light’s scrim is its ink, translucent', () => {
    expect(colours.scrim.slice(0, 7)).toBe(colours.ink);
  });
});

describe('the light theme', () => {
  it('the amber the web used before 0.4.4 would fail, which is why it changed', () => {
    expect(contrast('#B7791F', colours.surface)).toBeLessThan(AA);
    expect(contrast(colours.warn, colours.surface)).toBeGreaterThanOrEqual(AA);
  });

  it('white initials read on every avatar colour', () => {
    for (const c of AVATAR) {
      expect(contrast('#FFFFFF', c), c).toBeGreaterThanOrEqual(AA);
    }
    // The server's index wraps, and a negative one cannot break it.
    expect(avatarColour(AVATAR.length)).toBe(AVATAR[0]);
    expect(avatarColour(-1)).toBe(AVATAR[AVATAR.length - 1]);
  });

  it('contrast is the WCAG ratio', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('statusTone', () => {
  const all: StatusValue[] = [
    'active',
    'expiring_soon',
    'expired',
    'valid',
    'needs_info',
    'superseded',
    'missing',
  ];

  it('every status has words and an icon — never colour alone', () => {
    for (const value of all) {
      const t = statusTone({ value, label: `the words for ${value}` });
      if (value === 'valid') {
        expect(t).toBeNull();
        continue;
      }
      expect(t?.words, value).toBe(`the words for ${value}`);
      expect(t?.icon, value).toBeTruthy();
    }
  });

  it('a status this client has never heard of is shown plainly, not dropped', () => {
    const t = statusTone({ value: 'archived' as StatusValue, label: 'Archived' });
    expect(t).toEqual({ tone: 'neutral', icon: 'info', words: 'Archived' });
  });

  it('the tones are the ones the screens rely on', () => {
    expect(statusTone({ value: 'expired', label: 'x' })?.tone).toBe('danger');
    expect(statusTone({ value: 'expiring_soon', label: 'x' })?.tone).toBe('warn');
    expect(statusTone({ value: 'needs_info', label: 'x' })?.tone).toBe('warn');
    expect(statusTone({ value: 'active', label: 'x' })?.tone).toBe('ok');
  });
});

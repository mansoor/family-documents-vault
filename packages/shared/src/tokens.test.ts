import { describe, expect, it } from 'vitest';
import type { StatusValue } from './documents.js';
import { AVATAR, avatarColour, colours, contrast, statusTone } from './tokens.js';

/** WCAG 2.2 AA for body text (NFR-09). */
const AA = 4.5;
/** WCAG 2.2 AA for what marks out a control (1.4.11). */
const NON_TEXT = 3;

describe('the design tokens', () => {
  it('every text colour meets AA on each background it is drawn on', () => {
    const pairs: Array<[keyof typeof colours, keyof typeof colours]> = [
      ['ink', 'bg'],
      ['ink', 'surface'],
      ['inkSoft', 'bg'],
      ['inkSoft', 'surface'],
      ['inkMuted', 'bg'],
      ['inkMuted', 'surface'],
      ['accent', 'bg'],
      ['accent', 'surface'],
      ['accent', 'accentSoft'],
      ['ok', 'surface'],
      ['warn', 'bg'],
      ['warn', 'surface'],
      ['warn', 'warnSoft'],
      ['danger', 'bg'],
      ['danger', 'surface'],
      ['danger', 'dangerSoft'],
      ['onAccent', 'accent'],
      ['ink', 'highlight'],
    ];
    for (const [text, background] of pairs) {
      const ratio = contrast(colours[text], colours[background]);
      expect(ratio, `${text} on ${background}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('a text box or select is visible against every background it sits on', () => {
    for (const background of ['surface', 'bg'] as const) {
      const ratio = contrast(colours.borderInput, colours[background]);
      expect(ratio, `borderInput on ${background}`).toBeGreaterThanOrEqual(NON_TEXT);
    }
    // The plain border is for cards and dividers, which need not stand out.
    expect(contrast(colours.border, colours.surface)).toBeLessThan(NON_TEXT);
  });

  it('the translucent colours are ink and accent, not new ones', () => {
    expect(colours.scrim.slice(0, 7)).toBe(colours.ink);
    expect(colours.accentGlow.slice(0, 7)).toBe(colours.accent);
  });

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

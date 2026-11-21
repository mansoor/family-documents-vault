import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_FLYOUTS,
  flyoutsKey,
  forgetFlyouts,
  FREE_AFTER_MS,
  frontOf,
  fromStored,
  keepFlyouts,
  MAX_OPEN,
  minimisedIn,
  neighbourIn,
  openedIn,
  readFlyouts,
  shownIn,
  suggestions,
  sweptIn,
  toStored,
  withView,
  type FlyoutSet,
} from './flyout-store.js';

/**
 * The documents open beside the list, as plain data: opening, the front,
 * minimising, the limit of 10 and what to close first, freeing after 15
 * minutes minimised, and what is kept for a reload.
 */

const MIN = 60_000;

/** Opens each in turn, a minute apart: the last one in front. */
function opened(ids: string[], from = 0): FlyoutSet {
  let set = EMPTY_FLYOUTS;
  ids.forEach((id, i) => {
    const done = openedIn(set, id, from + i * MIN);
    if ('full' in done) throw new Error('full');
    set = done.set;
  });
  return set;
}

const states = (set: FlyoutSet) => set.items.map((it) => `${it.id}:${it.state}`);

afterEach(() => sessionStorage.clear());

describe('opening and the front', () => {
  it('a new one goes at the end, in front, its details shown; the one before goes to the tray', () => {
    const set = opened(['a', 'b']);
    expect(states(set)).toEqual(['a:min', 'b:shown']);
    expect(frontOf(set)).toBe('b');
    expect(set.items[1]?.view).toBe('both');
    expect(set.items[0]?.minimisedAt).toBe(MIN);
  });

  it('one already open comes to the front where it is, nothing added', () => {
    const done = openedIn(opened(['a', 'b', 'c']), 'a', 10 * MIN);
    expect('full' in done).toBe(false);
    if ('full' in done) return;
    expect(done.added).toBe(false);
    expect(states(done.set)).toEqual(['a:shown', 'b:min', 'c:min']);
    // Its clock is stopped; the one sent to the tray starts its own.
    expect(done.set.items[0]?.minimisedAt).toBeNull();
    expect(done.set.items[2]?.minimisedAt).toBe(10 * MIN);
  });

  it('minimised, none is in front; brought back, it is', () => {
    const set = minimisedIn(opened(['a']), 'a', 5 * MIN);
    expect(frontOf(set)).toBeNull();
    expect(set.items[0]).toMatchObject({ state: 'min', minimisedAt: 5 * MIN });
    expect(frontOf(shownIn(set, 'a', 6 * MIN))).toBe('a');
  });

  it('] and [ go round the tray from the one in front', () => {
    const set = opened(['a', 'b', 'c']);
    expect(neighbourIn(set, 1)).toBe('a');
    expect(neighbourIn(set, -1)).toBe('b');
    const none = minimisedIn(set, 'c', 0);
    expect(neighbourIn(none, 1)).toBe('a');
    expect(neighbourIn(none, -1)).toBe('c');
    expect(neighbourIn(EMPTY_FLYOUTS, 1)).toBeNull();
  });

  it('Hide details is each one’s own', () => {
    const set = withView(opened(['a', 'b']), 'a', 'content');
    expect(set.items.map((it) => it.view)).toEqual(['content', 'both']);
  });
});

describe('ten at most', () => {
  const ten = Array.from({ length: MAX_OPEN }, (_, i) => `d${i}`);

  it('every tray icon counts, freed ones too: the 11th is not opened', () => {
    let set = opened(ten);
    set = sweptIn(set, 9 * MIN + FREE_AFTER_MS).set;
    expect(set.items.filter((it) => it.state === 'freed').length).toBeGreaterThan(0);
    expect(openedIn(set, 'd10', 30 * MIN)).toEqual({ full: true });
    // One already open still comes to the front.
    expect('full' in openedIn(set, 'd3', 30 * MIN)).toBe(false);
  });

  it('suggests the freed first, then the minimised longest in the tray, the one in front last', () => {
    // d0..d9 opened a minute apart: d0..d8 minimised, d9 in front.
    let set = opened(ten);
    // Fifteen minutes after d2 was minimised (at 3 min), d0..d2 are freed.
    set = sweptIn(set, 3 * MIN + FREE_AFTER_MS).set;
    expect(states(set).slice(0, 4)).toEqual(['d0:freed', 'd1:freed', 'd2:freed', 'd3:min']);
    // d5 brought to the front later, d9 minimised then.
    set = shownIn(set, 'd5', 20 * MIN);
    expect(suggestions(set).map((it) => it.id)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
      'd4',
      'd6',
      'd7',
      'd8',
      'd9',
      'd5',
    ]);
  });
});

describe('freeing', () => {
  it('frees what has been minimised for 15 minutes, never what is in front', () => {
    const set = opened(['a', 'b', 'c']);
    // a minimised at 1 min, b at 2 min; c in front.
    expect(sweptIn(set, MIN + FREE_AFTER_MS - 1).freed).toEqual([]);
    const at = sweptIn(set, MIN + FREE_AFTER_MS);
    expect(at.freed).toEqual(['a']);
    expect(states(at.set)).toEqual(['a:freed', 'b:min', 'c:shown']);
    const later = sweptIn(at.set, 60 * MIN);
    expect(later.freed).toEqual(['b']);
    expect(states(later.set)).toEqual(['a:freed', 'b:freed', 'c:shown']);
  });

  it('the same set when nothing is due', () => {
    const set = opened(['a']);
    expect(sweptIn(set, 99 * MIN).set).toBe(set);
  });

  it('a freed one opens again when brought to the front', () => {
    const { set } = sweptIn(opened(['a', 'b']), 99 * MIN);
    expect(states(set)).toEqual(['a:freed', 'b:shown']);
    expect(states(shownIn(set, 'a', 100 * MIN))).toEqual(['a:shown', 'b:min']);
  });
});

describe('kept for a reload', () => {
  it('keeps ids and views only, and the front', () => {
    const set = withView(opened(['a', 'b']), 'a', 'content');
    expect(toStored(set)).toEqual({
      items: [
        { id: 'a', view: 'content' },
        { id: 'b', view: 'both' },
      ],
      front: 'b',
    });
  });

  it('comes back as tray icons, all freed but the one in front', () => {
    keepFlyouts('me', withView(opened(['a', 'b', 'c']), 'a', 'content'));
    expect(Object.keys(sessionStorage)).toEqual([flyoutsKey('me')]);
    const back = readFlyouts('me');
    expect(states(back)).toEqual(['a:freed', 'b:freed', 'c:shown']);
    expect(back.items[0]?.view).toBe('content');
    // Somebody else's is not theirs.
    expect(readFlyouts('m-2')).toEqual(EMPTY_FLYOUTS);
    expect(readFlyouts(null)).toEqual(EMPTY_FLYOUTS);
  });

  it('none in front is none in front after it', () => {
    keepFlyouts('me', minimisedIn(opened(['a']), 'a', 0));
    expect(states(readFlyouts('me'))).toEqual(['a:freed']);
  });

  it('takes back nothing it would not have kept', () => {
    expect(fromStored(null)).toEqual(EMPTY_FLYOUTS);
    expect(fromStored({ items: 'a' })).toEqual(EMPTY_FLYOUTS);
    const back = fromStored({
      items: [{ id: 'a' }, { id: 'a' }, { id: '<b>' }, { id: 7 }, null, { id: 'c', view: 'x' }],
      front: 'zz',
    });
    expect(back.items).toEqual([
      { id: 'a', state: 'freed', view: 'both', minimisedAt: null },
      { id: 'c', state: 'freed', view: 'both', minimisedAt: null },
    ]);
    const many = fromStored({ items: Array.from({ length: 14 }, (_, i) => ({ id: `d${i}` })) });
    expect(many.items).toHaveLength(MAX_OPEN);
  });

  it('none open, nothing kept', () => {
    keepFlyouts('me', opened(['a']));
    keepFlyouts('me', EMPTY_FLYOUTS);
    expect(sessionStorage.getItem(flyoutsKey('me'))).toBeNull();
  });

  it('a sign-out, a session’s end or somebody else signing in forgets every one', () => {
    keepFlyouts('me', opened(['a']));
    keepFlyouts('m-2', opened(['b']));
    sessionStorage.setItem('fdv.note-draft.x', 'kept');
    forgetFlyouts();
    expect(readFlyouts('me')).toEqual(EMPTY_FLYOUTS);
    expect(readFlyouts('m-2')).toEqual(EMPTY_FLYOUTS);
    // Only its own.
    expect(sessionStorage.getItem('fdv.note-draft.x')).toBe('kept');
  });
});

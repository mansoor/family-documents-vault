import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  besideIn,
  clampPane,
  closedIn,
  EMPTY_FLYOUTS,
  fewerIn,
  flyoutsKey,
  forgetFlyouts,
  FREE_AFTER_MS,
  frontOf,
  fromStored,
  isSideBySide,
  itemOf,
  keepFlyouts,
  keepPaneWidth,
  LIST_PEEK,
  MAX_OPEN,
  minimisedIn,
  mostSideBySide,
  neighbourIn,
  oneAtATimeIn,
  openedIn,
  PANE_MIN,
  paneBounds,
  paneDefault,
  paneWidthKey,
  readFlyouts,
  readPaneWidth,
  shownIn,
  SIDE_PANE_MIN,
  suggestions,
  sweptIn,
  toStored,
  TRAY_WIDTH,
  trayedIn,
  usedIn,
  withView,
  type FlyoutSet,
} from './flyout-store.js';

/**
 * The documents open beside the list, as plain data: opening, the front,
 * minimising, the limit of 10 and what to close first, freeing after 15
 * minutes minimised, what is kept for a reload, and two or three side by
 * side.
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

describe('side by side', () => {
  /** a, b and c opened a minute apart, then b beside c at 10 min: [c, b], b used last. */
  function pair(): FlyoutSet {
    const done = besideIn(opened(['a', 'b', 'c']), 'b', 10 * MIN);
    if ('full' in done) throw new Error('full');
    return done.set;
  }

  it('the second beside the one in front, at its right, the pane used last', () => {
    const set = pair();
    expect(set.side).toEqual(['c', 'b']);
    expect(set.last).toBe('b');
    expect(frontOf(set)).toBe('b');
    expect(isSideBySide(set)).toBe(true);
    expect(states(set)).toEqual(['a:min', 'b:shown', 'c:shown']);
    expect(set.items[1]?.minimisedAt).toBeNull();
    // A third from the list: opened, at the right.
    const third = besideIn(set, 'n', 11 * MIN);
    if ('full' in third) throw new Error('full');
    expect(third.added).toBe(true);
    expect(third.set.side).toEqual(['c', 'b', 'n']);
    expect(third.set.last).toBe('n');
  });

  it('a document opened from the list replaces the pane used last; it goes to the tray, nothing else', () => {
    let set = usedIn(pair(), 'c');
    expect(set.last).toBe('c');
    // With nothing to change: the same set.
    expect(usedIn(set, 'c')).toBe(set);
    expect(usedIn(set, 'a')).toBe(set);
    const done = openedIn(set, 'n', 12 * MIN);
    if ('full' in done) throw new Error('full');
    set = done.set;
    expect(done.added).toBe(true);
    expect(set.side).toEqual(['n', 'b']);
    expect(set.last).toBe('n');
    expect(states(set)).toEqual(['a:min', 'b:shown', 'c:min', 'n:shown']);
    // Its 15 minutes start as it leaves.
    expect(itemOf(set, 'c')?.minimisedAt).toBe(12 * MIN);
    // One from the tray (the keys, its icon) does the same.
    set = shownIn(set, 'a', 13 * MIN);
    expect(set.side).toEqual(['a', 'b']);
    expect(states(set)).toEqual(['a:shown', 'b:shown', 'c:min', 'n:min']);
    // One side by side already only becomes the pane used last.
    expect(shownIn(set, 'b', 14 * MIN).side).toEqual(['a', 'b']);
    expect(shownIn(set, 'b', 14 * MIN).last).toBe('b');
  });

  it('minimised or closed, the others stay; one left is one at a time', () => {
    const three = besideIn(pair(), 'a', 11 * MIN);
    if ('full' in three) throw new Error('full');
    let set = three.set;
    expect(set.side).toEqual(['c', 'b', 'a']);
    set = minimisedIn(set, 'a', 12 * MIN);
    expect(set.side).toEqual(['c', 'b']);
    expect(set.last).toBe('b');
    expect(itemOf(set, 'a')).toMatchObject({ state: 'min', minimisedAt: 12 * MIN });
    set = closedIn(set, 'c');
    expect(set.side).toEqual([]);
    expect(isSideBySide(set)).toBe(false);
    expect(states(set)).toEqual(['a:min', 'b:shown']);
    expect(frontOf(set)).toBe('b');
  });

  it('One at a time keeps the pane used last; the others start their 15 minutes then', () => {
    const set = usedIn(pair(), 'c');
    const one = oneAtATimeIn(set, 20 * MIN);
    expect(one.side).toEqual([]);
    expect(states(one)).toEqual(['a:min', 'b:min', 'c:shown']);
    expect(itemOf(one, 'b')?.minimisedAt).toBe(20 * MIN);
    // Never freed while shown, side by side or not.
    expect(sweptIn(set, 99 * MIN).set.side).toEqual(['c', 'b']);
    expect(states(sweptIn(set, 99 * MIN).set)).toEqual(['a:freed', 'b:shown', 'c:shown']);
    expect(sweptIn(one, 20 * MIN + FREE_AFTER_MS - 1).freed).toEqual(['a']);
    expect(oneAtATimeIn(one, 0)).toBe(one);
  });

  it('moving to another page puts every one shown in the tray', () => {
    const set = trayedIn(pair(), 30 * MIN);
    expect(set.side).toEqual([]);
    expect(states(set)).toEqual(['a:min', 'b:min', 'c:min']);
  });

  it('the limit counts every tray icon, those side by side too', () => {
    const nine = opened(Array.from({ length: 9 }, (_, i) => `d${i}`));
    const two = besideIn(nine, 'd9', 20 * MIN);
    if ('full' in two) throw new Error('full');
    expect(two.set.items).toHaveLength(MAX_OPEN);
    expect(two.set.side).toEqual(['d8', 'd9']);
    // An 11th, from the list or as a third, is not opened.
    expect(openedIn(two.set, 'd10', 21 * MIN)).toEqual({ full: true });
    expect(besideIn(two.set, 'd10', 21 * MIN)).toEqual({ full: true });
    // One open already can still be a third.
    expect('full' in besideIn(two.set, 'd0', 21 * MIN)).toBe(false);
    // Those side by side are suggested last.
    expect(
      suggestions(two.set)
        .slice(-2)
        .map((it) => it.id)
        .sort(),
    ).toEqual(['d8', 'd9']);
  });

  it('kept for a reload: which, in their order, the pane used last; ids and views only', () => {
    const set = withView(usedIn(pair(), 'c'), 'b', 'content');
    expect(toStored(set)).toEqual({
      items: [
        { id: 'a', view: 'both' },
        { id: 'b', view: 'content' },
        { id: 'c', view: 'both' },
      ],
      front: 'c',
      side: ['c', 'b'],
    });
    keepFlyouts('me', set);
    const back = readFlyouts('me');
    expect(back.side).toEqual(['c', 'b']);
    expect(back.last).toBe('c');
    // Those side by side come back loaded, the rest freed.
    expect(states(back)).toEqual(['a:freed', 'b:shown', 'c:shown']);
    expect(itemOf(back, 'b')?.view).toBe('content');
  });

  it('narrower than 1,100 px, a set side by side falls back to one at a time', () => {
    keepFlyouts('me', usedIn(pair(), 'c'));
    // After a reload: the pane used last alone, the rest freed.
    const back = readFlyouts('me', 0);
    expect(back.side).toEqual([]);
    expect(states(back)).toEqual(['a:freed', 'b:freed', 'c:shown']);
    // As the window narrows: the others minimised.
    const narrowed = oneAtATimeIn(usedIn(pair(), 'b'), 40 * MIN);
    expect(states(narrowed)).toEqual(['a:min', 'b:shown', 'c:min']);
  });

  it('with none in front, beside is a plain open', () => {
    const none = minimisedIn(opened(['a']), 'a', 0);
    const done = besideIn(none, 'b', MIN);
    if ('full' in done) throw new Error('full');
    expect(done.added).toBe(true);
    expect(done.set.side).toEqual([]);
    expect(states(done.set)).toEqual(['a:min', 'b:shown']);
  });

  it('a third only where each of three has its 300 px; fewer as the window narrows', () => {
    expect(mostSideBySide(3 * SIDE_PANE_MIN)).toBe(3);
    expect(mostSideBySide(3 * SIDE_PANE_MIN - 1)).toBe(2);
    const three = besideIn(usedIn(pair(), 'b'), 'a', 11 * MIN);
    if ('full' in three) throw new Error('full');
    // [c, b, a], a used last; then b used last.
    const set = usedIn(three.set, 'b');
    const two = fewerIn(set, 2, 20 * MIN);
    // The leftmost not used last goes to the tray, its clock started.
    expect(two.side).toEqual(['b', 'a']);
    expect(two.last).toBe('b');
    expect(itemOf(two, 'c')).toMatchObject({ state: 'min', minimisedAt: 20 * MIN });
    expect(fewerIn(two, 2, 0)).toBe(two);
    expect(fewerIn(two, 0, 30 * MIN).side).toEqual([]);
    expect(states(fewerIn(two, 0, 30 * MIN))).toEqual(['a:min', 'b:shown', 'c:min']);
    // Kept three, back with room for two: the one used last among them.
    keepFlyouts('me', set);
    const back = readFlyouts('me', 2);
    expect(back.side).toEqual(['b', 'a']);
    expect(back.last).toBe('b');
    expect(states(back)).toEqual(['a:shown', 'b:shown', 'c:freed']);
  });

  it('the stylesheet works out the room with the same numbers', () => {
    const file = ['src/styles.css', 'apps/web/src/styles.css']
      .map((p) => resolve(process.cwd(), p))
      .find((p) => existsSync(p));
    const css = file ? readFileSync(file, 'utf8') : '';
    expect(css).toContain(`--list-peek: ${LIST_PEEK}px;`);
    expect(css).toContain(`--tray-now: ${TRAY_WIDTH}px;`);
    expect(css).toMatch(
      /--side-room: calc\(\s*100vw - var\(--side-w, 216px\) - var\(--tray-now, 0px\) - var\(--list-peek\)\s*\)/,
    );
    // The one alone, by its edge: paneBounds' numbers.
    expect(css).toContain(`--pane-min: ${PANE_MIN}px;`);
    expect(css).toContain(
      '--pane-default: min(calc(100vw - var(--tray-now, 0px)), clamp(720px, 62vw, 1100px));',
    );
    expect(css).toMatch(
      /--pane-room: calc\(\s*100vw - var\(--page-start, 0px\) - var\(--tray-now, 0px\) - var\(--list-peek\)\s*\)/,
    );
  });

  it('takes back no side by side it would not have kept', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    for (const side of [['a'], ['a', 'a'], ['a', 'zz'], ['a', 'b', 'c', 'd'], 'ab', [1, 2]]) {
      const back = fromStored({ items, front: 'a', side });
      expect(back.side).toEqual([]);
      expect(states(back)).toEqual(['a:shown', 'b:freed', 'c:freed', 'd:freed']);
    }
    // The front not among them: the last of them is the pane used last.
    const back = fromStored({ items, front: 'd', side: ['b', 'c'] });
    expect(back.last).toBe('c');
    expect(states(back)).toEqual(['a:freed', 'b:shown', 'c:shown', 'd:freed']);
  });
});

describe('the width of the one alone', () => {
  afterEach(() => localStorage.clear());

  it('starts as ever; at least PANE_MIN; at most the room that keeps the list in sight, or where it starts', () => {
    // 62vw, between 720 and 1,100 px, and never past the tray.
    expect(paneDefault(1600)).toBeCloseTo(992);
    expect(paneDefault(2400)).toBe(1100);
    expect(paneDefault(1000)).toBe(720);
    expect(paneDefault(760)).toBe(760 - TRAY_WIDTH);
    // Roomy: the window less the sidebar, the tray and the list's 240 px.
    expect(paneBounds(1600, 216)).toEqual({ min: PANE_MIN, max: 1068, start: 992 });
    expect(paneBounds(1920, 72)).toEqual({ min: PANE_MIN, max: 1920 - 72 - 76 - 240, start: 1100 });
    // Too narrow for that: no wider than it starts, so nothing jumps.
    expect(paneBounds(1280, 216)).toEqual({ min: PANE_MIN, max: 794, start: 794 });
    expect(paneBounds(800, 72)).toEqual({ min: PANE_MIN, max: 720, start: 720 });
    const b = paneBounds(1600, 216);
    expect(clampPane(100, b)).toBe(PANE_MIN);
    expect(clampPane(5000, b)).toBe(1068);
    expect(clampPane(700.4, b)).toBe(700);
  });

  it('kept in this browser for each person: the number alone', () => {
    expect(readPaneWidth('me')).toBeNull();
    keepPaneWidth('me', 640.6);
    expect(localStorage.getItem(paneWidthKey('me'))).toBe('641');
    expect(readPaneWidth('me')).toBe(641);
    expect(readPaneWidth('someone-else')).toBeNull();
    expect(readPaneWidth(null)).toBeNull();
    keepPaneWidth(null, 500);
    expect(localStorage.length).toBe(1);
    for (const bad of ['', 'wide', '-4', '0', 'NaN', '1e9']) {
      localStorage.setItem(paneWidthKey('me'), bad);
      expect(readPaneWidth('me')).toBeNull();
    }
    keepPaneWidth('me', null);
    expect(localStorage.getItem(paneWidthKey('me'))).toBeNull();
    // Not the tab's open documents: a sign-out's forgetting leaves it.
    keepPaneWidth('me', 500);
    forgetFlyouts();
    expect(readPaneWidth('me')).toBe(500);
  });
});

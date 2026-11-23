import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FILTER_VALUES_MAX } from '@fdv/shared';
import axe from 'axe-core';
import { startTransition, useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { filterButton, filterSays, openFilter, tick } from './filter-testing.js';
import { CAP_WORDS, ChipRow, FIND_FROM, MultiFilter, type FilterOption } from './multi-filter.js';

/**
 * A filter of several choices and its chips (0.9.0-dev.92), by themselves:
 * the find box, Show all, the cap, words for what cannot be named, and the
 * focus never lost — however late the page is drawn after a change.
 */

afterEach(cleanup);

async function expectAccessible() {
  const results = await axe.run(document.body, {
    rules: { 'color-contrast': { enabled: false } },
  });
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const PEOPLE: FilterOption[] = [
  { value: 'm-1', label: 'Sam' },
  { value: 'm-2', label: 'Leo' },
  { value: 'm-3', label: 'Ana' },
];

/**
 * A filter as a page holds one: its values its own state, each change
 * drawn `delay` ms later, as a router's transition may draw it.
 */
function Harness(props: {
  start?: string[];
  options?: FilterOption[];
  delay?: number;
  inline?: boolean;
  room?: number;
  withChips?: boolean;
  /** Each change drawn in a transition that waits for this, as a router's may. */
  gate?: Promise<void>;
  /** The values, set from outside: Back to an address already seen. */
  outside?: (set: (v: string[]) => void) => void;
}) {
  const [values, setValues] = useState<string[]>(props.start ?? []);
  props.outside?.(setValues);
  const fallback = useRef<HTMLDivElement>(null);
  const set = (v: string[]) => {
    const gate = props.gate;
    if (gate) {
      startTransition(async () => {
        await gate;
        startTransition(() => setValues(v));
      });
    } else if (props.delay) window.setTimeout(() => setValues(v), props.delay);
    else setValues(v);
  };
  const options = props.options ?? PEOPLE;
  return (
    <main>
      <div ref={fallback} role="group" aria-label="Filters" tabIndex={-1}>
        <MultiFilter
          id="f-person"
          label="Person"
          any="All people"
          values={values}
          options={options}
          unknown={() => 'someone in the family'}
          inline={props.inline}
          field="person"
          room={props.room}
          onChange={set}
        />
      </div>
      {props.withChips && (
        <ChipRow
          label="Filters chosen"
          chips={values.map((v) => ({
            key: v,
            words: `Person: ${options.find((o) => o.value === v)?.label ?? 'someone in the family'}`,
            clear: () => set(values.filter((x) => x !== v)),
          }))}
          onClearAll={() => set([])}
          fallback={fallback}
        />
      )}
    </main>
  );
}

describe('a filter of several choices (0.9.0-dev.92)', () => {
  it('says what it holds, Show all at the top once anything is chosen, and is accessible', async () => {
    render(<Harness />);
    const page = document.body;
    expect(filterSays(page, 'Person')).toBe('All people');
    const menu = openFilter(page, 'Person');
    expect(within(menu).queryByRole('button', { name: 'Show all' })).toBeNull();
    tick(page, 'Person', 'Sam', 'Leo');
    expect(filterSays(page, 'Person')).toBe('Person · 2');
    // Show all first, before the boxes; never the closed button's words.
    const show = within(menu).getByRole('button', { name: 'Show all' });
    expect(
      show.compareDocumentPosition(within(menu).getAllByRole('checkbox')[0] as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(menu).queryByRole('button', { name: 'All people' })).toBeNull();
    await expectAccessible();
    fireEvent.click(show);
    expect(filterSays(page, 'Person')).toBe('All people');
    expect(filterButton(page, 'Person')).toHaveFocus();
  });

  it('names a value it cannot, never by its id: on the button and its box', () => {
    render(<Harness start={['m-9']} />);
    const page = document.body;
    expect(filterSays(page, 'Person')).toBe('someone in the family');
    const menu = openFilter(page, 'Person');
    expect(within(menu).getByRole('checkbox', { name: 'someone in the family' })).toBeChecked();
    expect(document.body.textContent).not.toContain('m-9');
  });

  it('a value no longer offered, unticked, gives the focus to the next box, the list still open', async () => {
    render(<Harness start={['m-9', 'm-1']} delay={5} />);
    const page = document.body;
    const menu = openFilter(page, 'Person');
    const stale = within(menu).getByRole('checkbox', { name: 'someone in the family' });
    act(() => stale.focus());
    fireEvent.click(stale);
    await waitFor(() =>
      expect(within(menu).queryByRole('checkbox', { name: 'someone in the family' })).toBeNull(),
    );
    // It was the last box: the one before it has the focus now.
    await waitFor(() => expect(within(menu).getByRole('checkbox', { name: 'Ana' })).toHaveFocus());
    expect(filterButton(page, 'Person')).toHaveAttribute('aria-expanded', 'true');
  });

  it('finds a choice in a long list, keeping what is chosen there to untick', async () => {
    const many = Array.from({ length: FIND_FROM + 3 }, (_, i) => ({
      value: `t${i}`,
      label: `Tag ${i}`,
    }));
    render(<Harness options={many} start={['t0']} />);
    const page = document.body;
    const menu = openFilter(page, 'Person');
    const find = within(menu).getByRole('searchbox', { name: 'Find a person' });
    fireEvent.change(find, { target: { value: 'tag 1' } });
    expect(
      within(menu)
        .getAllByRole('checkbox')
        .map((b) => b.closest('.check')?.textContent),
    ).toEqual(['Tag 0', 'Tag 1', 'Tag 10', 'Tag 11', 'Tag 12', 'Tag 13', 'Tag 14']);
    fireEvent.change(find, { target: { value: 'nothing like it' } });
    expect(within(menu).getAllByRole('checkbox')).toHaveLength(1);
    await expectAccessible();
  });

  it('takes no more than the vault does: past the cap, the other boxes say why', () => {
    const many = Array.from({ length: FILTER_VALUES_MAX + 2 }, (_, i) => ({
      value: `t${i}`,
      label: `Tag ${i}`,
    }));
    render(<Harness options={many} start={many.slice(0, FILTER_VALUES_MAX).map((o) => o.value)} />);
    const menu = openFilter(document.body, 'Person');
    const more = within(menu).getByRole('checkbox', { name: `Tag ${FILTER_VALUES_MAX}` });
    expect(more).toBeDisabled();
    expect(more).toHaveAccessibleDescription(CAP_WORDS);
    // One taken off: room again.
    tick(document.body, 'Person', 'Tag 0');
    expect(more).toBeEnabled();
  });

  it('never makes an address too long: a value with no room left is not offered', () => {
    const long = { value: 'x'.repeat(300), label: 'A very long tag' };
    render(<Harness options={[...PEOPLE, long]} room={200} />);
    const menu = openFilter(document.body, 'Person');
    expect(within(menu).getByRole('checkbox', { name: 'A very long tag' })).toBeDisabled();
    expect(within(menu).getByRole('checkbox', { name: 'Sam' })).toBeEnabled();
    expect(within(menu).getByText(CAP_WORDS)).toBeVisible();
  });

  it('in a sheet: its boxes under its name, a find box and a bounded list, accessible', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ value: `t${i}`, label: `Tag ${i}` }));
    render(<Harness inline options={many} start={['t3']} />);
    const group = screen.getByRole('group', { name: 'Person' });
    expect(within(group).getByRole('searchbox', { name: 'Find a person' })).toBeVisible();
    expect(group.querySelector('.multi-filter-list')).not.toBeNull();
    expect(within(group).getByRole('button', { name: 'Show all' })).toBeVisible();
    await expectAccessible();
  });
});

describe('a box shows its tick at once, whenever the address is drawn (0.9.0-dev.92)', () => {
  it('ticked, it is ticked straight after the click, the change still in its transition', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    render(<Harness gate={gate} />);
    const page = document.body;
    const menu = openFilter(page, 'Person');
    const sam = within(menu).getByRole('checkbox', { name: 'Sam' });
    fireEvent.click(sam);
    // The address not drawn yet: the box, the button and Show all say it already.
    expect(sam).toBeChecked();
    expect(filterSays(page, 'Person')).toBe('Sam');
    expect(within(menu).getByRole('button', { name: 'Show all' })).toBeVisible();
    fireEvent.click(within(menu).getByRole('checkbox', { name: 'Leo' }));
    expect(within(menu).getByRole('checkbox', { name: 'Leo' })).toBeChecked();
    expect(sam).toBeChecked();
    // Drawn: still so.
    await act(async () => {
      open();
      await gate;
    });
    await waitFor(() => expect(filterSays(page, 'Person')).toBe('Person · 2'));
    expect(sam).toBeChecked();
    // Show all, at once too.
    fireEvent.click(within(menu).getByRole('button', { name: 'Show all' }));
    expect(filterSays(page, 'Person')).toBe('All people');
  });

  it('once the address has caught up, Back to an address seen before shows that address', async () => {
    let setOutside!: (v: string[]) => void;
    render(
      <Harness
        outside={(set) => {
          setOutside = set;
        }}
      />,
    );
    const page = document.body;
    tick(page, 'Person', 'Sam');
    expect(filterSays(page, 'Person')).toBe('Sam');
    // Back: the address as it was, no choice.
    act(() => setOutside([]));
    expect(filterSays(page, 'Person')).toBe('All people');
    expect(
      within(openFilter(page, 'Person')).getByRole('checkbox', { name: 'Sam' }),
    ).not.toBeChecked();
  });
});

describe('chips of the choices made (0.9.0-dev.92)', () => {
  it('taking one off gives the focus to the next, once the page is drawn without it', async () => {
    render(<Harness withChips start={['m-1', 'm-2', 'm-3']} delay={20} />);
    const chips = screen.getByRole('group', { name: 'Filters chosen' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Take off the filter Person: Leo' }));
    // Not yet drawn: nothing has moved the focus anywhere else meanwhile.
    expect(
      within(chips).getByRole('button', { name: 'Take off the filter Person: Leo' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take off the filter Person: Ana' })).toHaveFocus(),
    );
    // The last: the one before it.
    fireEvent.click(screen.getByRole('button', { name: 'Take off the filter Person: Ana' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Take off the filter Person: Sam' })).toHaveFocus(),
    );
    // None left: the filters.
    fireEvent.click(screen.getByRole('button', { name: 'Take off the filter Person: Sam' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Filters' })).toHaveFocus());
    expect(screen.queryByRole('group', { name: 'Filters chosen' })).toBeNull();
  });

  it('Clear all leaves the focus among the filters', async () => {
    render(<Harness withChips start={['m-1', 'm-2']} delay={20} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Filters' })).toHaveFocus());
  });
});

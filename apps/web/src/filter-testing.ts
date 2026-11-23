import { fireEvent, within } from '@testing-library/react';

/**
 * Tests' hands on a filter of several choices (0.9.0-dev.92, multi-filter.tsx):
 * its button, named "Person: All people", and the boxes it opens.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A filter's button, by the filter's name: "Person: Sam", "Person · 2". */
export function filterButton(scope: HTMLElement, name: string): HTMLElement {
  return within(scope).getByRole('button', { name: new RegExp(`^${escape(name)}: `) });
}

/** What a filter's button says after its name: "All people", "Sam", "Person · 2". */
export function filterSays(scope: HTMLElement, name: string): string {
  return (filterButton(scope, name).textContent ?? '').replace('▾', '').trim();
}

/** A filter opened, if it is not: its boxes. */
export function openFilter(scope: HTMLElement, name: string): HTMLElement {
  const button = filterButton(scope, name);
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
  return within(scope).getByRole('group', { name: `${name}: any of these` });
}

/** Ticks (or unticks) each of these choices of a filter, by their names. */
export function tick(scope: HTMLElement, name: string, ...choices: string[]): void {
  for (const c of choices) {
    fireEvent.click(within(openFilter(scope, name)).getByRole('checkbox', { name: c }));
  }
}

/** The names of the choices ticked in a filter. */
export function ticked(scope: HTMLElement, name: string): string[] {
  return within(openFilter(scope, name))
    .getAllByRole('checkbox')
    .filter((b) => (b as HTMLInputElement).checked)
    .map((b) => b.closest('.check')?.querySelector('label')?.textContent ?? '');
}

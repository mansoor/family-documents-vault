import { within } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * That a dialog is the app's one dialog (0.9.0-dev.67): a card over the
 * page, named by its own title, with its row of buttons ending in the one
 * that closes it.
 */
export function expectSharedDialog(dialog: HTMLElement, title: string | RegExp, close = 'Close') {
  expect(dialog).toHaveAttribute('role', 'dialog');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveClass('sheet', 'card', 'stack', 'dialog');
  const heading = within(dialog).getByRole('heading', { level: 2, name: title });
  expect(heading).toHaveClass('dialog-title');
  expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
  const row = dialog.querySelector<HTMLElement>(':scope > .dialog-actions');
  if (!row) throw new Error('the dialog has no row of buttons');
  const buttons = within(row).getAllByRole('button');
  expect(buttons[buttons.length - 1]).toHaveTextContent(close);
}

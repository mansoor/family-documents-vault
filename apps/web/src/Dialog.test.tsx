import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { expectSharedDialog } from './dialog-testing.js';
import { Button, Dialog } from './ui.js';

/**
 * The app's one dialog (0.9.0-dev.67, the owner's feedback of 18 Nov 2026):
 * named by its title, a card over the page, its buttons in one row ending
 * with the one that closes it; Escape and Tab as every sheet's.
 */

afterEach(cleanup);

function Page(props: { busy?: boolean; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <Button ref={opener} onClick={() => setOpen(true)}>
        Open it
      </Button>
      <p>{said}</p>
      {open && (
        <Dialog
          title="Add managers"
          busy={props.busy === true}
          wide={props.wide === true}
          returnFocus={opener}
          onClose={() => setOpen(false)}
          actions={<Button onClick={() => setSaid('Done it')}>Do it</Button>}
        >
          <p className="muted">What it is about.</p>
        </Dialog>
      )}
    </main>
  );
}

describe('the one dialog', () => {
  it('is named by its title, starts inside, closes from its button or Escape, and gives the focus back', async () => {
    render(<Page />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Add managers' });
    expectSharedDialog(dialog, 'Add managers');
    expect(dialog).not.toHaveClass('dialog-wide');
    // The focus starts on its first button, and Tab stays inside.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Do it' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Do it' }));
    const results = await axe.run(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(screen.getByText('Done it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits while something is on its way, and can be wide', () => {
    render(<Page busy wide />);
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }));
    const dialog = screen.getByRole('dialog', { name: 'Add managers' });
    expect(dialog).toHaveClass('dialog-wide');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Add managers' })).toBeInTheDocument();
  });
});

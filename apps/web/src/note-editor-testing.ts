import { noteTreeToMarkdown, parseNotes } from '@fdv/shared';
import { fireEvent } from '@testing-library/react';
import { drawNote, readNote } from './rich-text.js';

/**
 * The note editor in jsdom (0.9.0, N1), which has no editing of its own:
 * what a person writes is put on the page as the editor would show it, and
 * the editor told, as a browser tells it, that its words changed.
 */
export function writeInto(box: HTMLElement, note: string): void {
  box.replaceChildren(drawNote(parseNotes(note), box.ownerDocument));
  fireEvent.input(box);
}

/** What the editor's words say, as Save would send them. */
export function writtenIn(box: HTMLElement): string {
  return noteTreeToMarkdown(readNote(box));
}

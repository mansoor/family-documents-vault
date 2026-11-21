import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { forgetAllPages } from './batch-pages.js';
import { forgetFlyouts } from './flyout-store.js';

// Without Vitest globals, Testing Library does not register its own cleanup.
// A batch's first pages are held for the page's life (I1): not into the next test.
// Nor the documents a test left open beside the list, kept for the tab.
afterEach(() => {
  cleanup();
  forgetAllPages();
  forgetFlyouts();
});

// findBy and waitFor give up after this long. The default, 1 s, is too short
// for a file's first screen while the whole gate runs at once: Collections.test's
// first search took longer (5.15). It is a ceiling; a passing wait is no slower.
configure({ asyncUtilTimeout: 3000 });

import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Without Vitest globals, Testing Library does not register its own cleanup.
afterEach(() => cleanup());

// findBy and waitFor give up after this long. The default, 1 s, is too short
// for a file's first screen while the whole gate runs at once: Lists.test's
// first search took longer (5.15). It is a ceiling; a passing wait is no slower.
configure({ asyncUtilTimeout: 3000 });

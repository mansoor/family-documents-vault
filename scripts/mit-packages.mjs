// The MIT packages, and what each may use at run time: read by
// check-mit-boundary.mjs (the source) and client-pack.mjs (the tarball each
// release carries), so the two never disagree.

/**
 * Each MIT package, and the only packages it may use at run time: each of
 * them MIT itself. libphonenumber-js (MIT) reads a mobile number typed for
 * text messages (0.9.0).
 */
export const MIT = {
  'packages/shared': ['libphonenumber-js'],
  'packages/client': ['@fdv/shared'],
};

/** Used by tests, and by the client's `testing` entry that tests import. */
export const TEST_ONLY = new Set(['vitest']);

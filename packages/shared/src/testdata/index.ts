/**
 * 5.37's synthetic documents, and how proposals are scored against them:
 * for tests elsewhere that run them through another path — Phase 6's items
 * (the worker's reading, I2). Made up, every one: none is a real document.
 * And how the Smart exit (0.8.0, S5) scores a batch item's card against
 * its corpus's truth (scripts/smart-corpus.mjs).
 */
export * from './proposal-fixtures.js';
export * from './proposal-accuracy.js';
export * from './smart-exit.js';
export * from './c1-fixtures.js';
// The reader before C1 (0.9.0), frozen: for the Smart exit's papers read both ways.
export * as readerBeforeC1 from './proposals-before-c1.js';

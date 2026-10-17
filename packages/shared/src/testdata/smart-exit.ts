/**
 * How the Smart exit (0.8.0, S5) scores a batch item's card against its
 * corpus's truth: since 0.9.0 (R0) in @fdv/shared's reading-score.ts, where
 * the Reading check scores a family's own papers with the same rules. One
 * scorer, never two.
 */
export * from '../reading-score.js';

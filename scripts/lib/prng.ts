/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * Seeded generation is what lets the integration tests assert absolute figures. With Math.random the
 * seeded dataset differs every run, so a test could only ever re-sum what the API returned and check
 * it against itself — which passes just as happily when both sides are wrong. A fixed seed produces
 * the same 2 000 transactions every time, and the seeder writes out the totals it built them from, so
 * the aggregation tools are checked against an oracle computed independently of the API.
 */
export interface Prng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform pick. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p`. */
  chance(p: number): boolean;
}

export function createPrng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)],
    chance: (p: number): boolean => next() < p,
  };
}

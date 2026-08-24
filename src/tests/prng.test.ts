import { describe, expect, it } from 'vitest';
import { createPrng } from '../../scripts/lib/prng.js';

describe('createPrng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    // This is the property the seeded dataset rests on: without it, tests could only ever re-sum
    // what the API returned and compare it to itself.
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    expect(createPrng(1).next()).not.toBe(createPrng(2).next());
  });

  it('stays within [0, 1)', () => {
    const rng = createPrng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int is inclusive at both ends and never goes outside them', () => {
    const rng = createPrng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(1, 5));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('pick only ever returns a member of the list', () => {
    const rng = createPrng(3);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 200; i++) expect(items).toContain(rng.pick(items));
  });

  it('chance approximates its probability', () => {
    const rng = createPrng(11);
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(0.25)) hits++;
    expect(hits / 10_000).toBeGreaterThan(0.22);
    expect(hits / 10_000).toBeLessThan(0.28);
  });
});

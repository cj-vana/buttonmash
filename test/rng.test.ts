import { describe, it, expect } from 'vitest';
import { Rng, splitmix32, xmur3 } from '../src/core/rng';

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng('hello');
    const b = new Rng('hello');
    const seqA = Array.from({ length: 10 }, () => a.float());
    const seqB = Array.from({ length: 10 }, () => b.float());
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds', () => {
    const ra = new Rng('one');
    const rb = new Rng('two');
    const seqA = Array.from({ length: 5 }, () => ra.float());
    const seqB = Array.from({ length: 5 }, () => rb.float());
    expect(seqA).not.toEqual(seqB);
  });

  it('produces floats in [0,1)', () => {
    const r = new Rng('range');
    for (let i = 0; i < 1000; i++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('int respects bounds and handles empties', () => {
    const r = new Rng('int');
    for (let i = 0; i < 200; i++) expect(r.int(5)).toBeLessThan(5);
    expect(r.int(0)).toBe(0);
    expect(r.intBetween(3, 3)).toBe(3);
  });

  it('pick throws on empty and returns members otherwise', () => {
    const r = new Rng('pick');
    expect(() => r.pick([])).toThrow();
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) expect(arr).toContain(r.pick(arr));
  });

  it('weightedPick honors weights', () => {
    const r = new Rng('weights');
    const items = [
      { item: 'rare', weight: 1 },
      { item: 'common', weight: 99 },
    ];
    let common = 0;
    for (let i = 0; i < 1000; i++) if (r.weightedPick(items) === 'common') common++;
    expect(common).toBeGreaterThan(900);
  });

  it('shuffle is a deterministic permutation', () => {
    const base = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = new Rng('s').shuffle([...base]);
    const s2 = new Rng('s').shuffle([...base]);
    expect(s1).toEqual(s2);
    expect([...s1].sort((a, b) => a - b)).toEqual(base);
  });

  it('xmur3/splitmix32 are pure helpers', () => {
    const seeder = xmur3('abc');
    const gen = splitmix32(seeder());
    const v = gen();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('in-page seed derivation matches the engine (locks browser.ts seedPageRandom)', () => {
    // Mirror of src/session/browser.ts seedPageRandom's derivation. If this
    // drifts from xmur3(seed)(), the in-page Math.random stops matching the
    // engine RNG and this test fails.
    const pageSeed = (seed: string): number => {
      let h = 1779033703 ^ seed.length;
      for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
    for (const seed of ['ci', 'hello-world', '42']) {
      expect(pageSeed(seed)).toBe(xmur3(seed)());
    }
  });
});

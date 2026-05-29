/**
 * Deterministic, seeded pseudo-random number generation.
 *
 * The entire monkey is driven by a single {@link Rng} instance so that a given
 * seed reproduces the monkey's sequence of choices. Nothing in the engine may
 * call `Math.random` directly — every choice flows through here. (Replay is
 * reliable when the app renders the same DOM for the same inputs; the page
 * clock is deliberately not frozen, so heavily time/async-driven apps may
 * still diverge — see the README.)
 *
 * Algorithms (zero-dependency, full 32-bit math via `Math.imul`):
 *  - `xmur3`     hashes an arbitrary string seed into 32-bit integers.
 *  - `splitmix32` is a full-period 32-bit PRNG producing floats in [0, 1).
 *
 * Refs: https://github.com/bryc/code/blob/master/jshash/PRNGs.md
 */

/** Hash a string seed into a generator of well-distributed 32-bit integers. */
export function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Full-period 32-bit PRNG. Returns a function yielding floats in [0, 1). */
export function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;

  constructor(public readonly seed: string) {
    const seeder = xmur3(seed);
    this.next = splitmix32(seeder());
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [0, maxExclusive). Returns 0 when maxExclusive <= 0. */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.next() * maxExclusive);
  }

  /** Integer in [lo, hi] inclusive. */
  intBetween(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + this.int(hi - lo + 1);
  }

  /** Pick a uniformly random element. Throws on empty input. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[this.int(arr.length)] as T;
  }

  /** Pick by weight. Items with non-positive weight are never chosen. */
  weightedPick<T>(items: readonly { item: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
    if (total <= 0) return this.pick(items.map((i) => i.item));
    let r = this.next() * total;
    for (const { item, weight } of items) {
      r -= Math.max(0, weight);
      if (r <= 0) return item;
    }
    return items[items.length - 1]!.item;
  }

  /** True with probability p (default 0.5). */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Deterministic in-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
    }
    return arr;
  }
}

/** Generate a memorable default seed when the user does not supply one. */
export function makeDefaultSeed(): string {
  // Intentionally based on time so unseeded runs vary; printed at startup so
  // the user can pin it for reproduction. A seeded run never calls this.
  return `bm-${Date.now().toString(36)}`;
}

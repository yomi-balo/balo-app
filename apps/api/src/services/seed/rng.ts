/**
 * Deterministic randomness for the BAL-239 seeder.
 *
 * Two cooperating sources, both seeded from the SAME integer:
 *   1. faker — for human-ish strings (names, bios). `seedFaker(seed)` pins its
 *      internal PRNG so the i-th `faker.person.firstName()` call is stable.
 *   2. `WeightedRng` (mulberry32) — for every numeric / weighted decision, so
 *      weighting does NOT depend on faker internals and stays stable even if a
 *      faker version bump changes how many random draws a helper consumes.
 *
 * IMPORTANT: do not reorder decisions that pull from a `WeightedRng` instance —
 * each `next()` advances the stream, so order is part of the contract.
 */
import { faker } from '@faker-js/faker';

/** Seed faker's global PRNG. Call once at the top of each pure generator. */
export function seedFaker(seed: number): void {
  faker.seed(seed);
}

/** Re-export the seeded faker instance for generators (single source). */
export { faker };

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG. Same seed ⇒ same
 * sequence on every platform (pure integer math, no Math.random).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WeightedRng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** Float in `[min, max)`. */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in `[min, max]` inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  /** True with probability `p` (0..1). */
  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. Throws on empty input. */
  pickOne<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('WeightedRng.pickOne: empty array');
    const idx = this.int(0, items.length - 1);
    return items[idx]!;
  }

  /**
   * Weighted pick: `weights[i]` is the relative weight of `items[i]`. Throws if
   * lengths mismatch or all weights are non-positive.
   */
  pick<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) {
      throw new Error('WeightedRng.pick: items/weights length mismatch');
    }
    const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
    if (total <= 0) throw new Error('WeightedRng.pick: weights sum to zero');

    let threshold = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      threshold -= Math.max(0, weights[i]!);
      if (threshold < 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /**
   * Weighted sampling WITHOUT replacement: pick `n` distinct items by repeatedly
   * weighted-picking and removing the chosen entry. Caps `n` at the pool size.
   */
  sampleWeighted<T>(items: readonly T[], weights: readonly number[], n: number): T[] {
    if (items.length !== weights.length) {
      throw new Error('WeightedRng.sampleWeighted: items/weights length mismatch');
    }
    const pool = items.map((item, i) => ({ item, weight: Math.max(0, weights[i]!) }));
    const take = Math.min(n, pool.length);
    const out: T[] = [];
    for (let k = 0; k < take; k++) {
      const total = pool.reduce((sum, e) => sum + e.weight, 0);
      if (total <= 0) {
        // Remaining weights all zero — fall back to uniform over the pool.
        const idx = this.int(0, pool.length - 1);
        out.push(pool.splice(idx, 1)[0]!.item);
        continue;
      }
      let threshold = this.next() * total;
      let chosen = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        threshold -= pool[i]!.weight;
        if (threshold < 0) {
          chosen = i;
          break;
        }
      }
      out.push(pool.splice(chosen, 1)[0]!.item);
    }
    return out;
  }
}

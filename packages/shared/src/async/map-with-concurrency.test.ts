import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('mapWithConcurrency', () => {
  it('returns results in input order even when calls settle out of order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const run = mapWithConcurrency([0, 1, 2], 3, async (item) => {
      await gates[item]?.promise;
      return `r${item}`;
    });
    gates[2]?.resolve();
    gates[0]?.resolve();
    gates[1]?.resolve();
    expect(await run).toEqual(['r0', 'r1', 'r2']);
  });

  it('never exceeds the limit of calls in flight', async () => {
    const gates = Array.from({ length: 6 }, deferred);
    let inFlight = 0;
    let peak = 0;
    const run = mapWithConcurrency(gates, 2, async (gate) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight -= 1;
    });
    for (const gate of gates) {
      await tick();
      gate.resolve();
    }
    await run;
    expect(peak).toBe(2);
  });

  it('is strictly sequential and in order at limit 1', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const run = mapWithConcurrency(gates, 1, async (gate, index) => {
      started.push(index);
      await gate.promise;
    });
    await tick();
    expect(started).toEqual([0]);
    gates[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[2]?.resolve();
    await run;
  });

  it('returns an empty array for empty input without calling fn', async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 3, async () => {
      calls += 1;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it('works when the limit exceeds the input length', async () => {
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('passes undefined items through', async () => {
    expect(await mapWithConcurrency([undefined, 1], 1, async (n, i) => `${i}:${n}`)).toEqual([
      '0:undefined',
      '1:1',
    ]);
  });

  it('rejects when fn rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return n;
      })
    ).rejects.toThrow('boom');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws RangeError for limit %s',
    async (limit) => {
      await expect(mapWithConcurrency([1], limit, async (n) => n)).rejects.toBeInstanceOf(
        RangeError
      );
    }
  );
});

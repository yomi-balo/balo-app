/**
 * Maps `items` through the async `fn` with at most `limit` calls in flight, returning the
 * results in input order. A `limit` of 1 is strictly sequential: call i+1 starts only after
 * call i settles. A rejection from `fn` rejects the returned promise.
 *
 * Workers recurse instead of looping: each claims the next unclaimed entry, awaits `fn`, then
 * hands the following entry to a fresh invocation of itself.
 *
 * @throws RangeError when `limit` is not a positive integer.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, received ${limit}`);
  }

  const results: R[] = new Array<R>(items.length);
  // One iterator shared by every worker: each `next()` claims the following entry exactly once.
  const pending = items.entries();

  async function worker(): Promise<void> {
    const claimed = pending.next();
    if (claimed.done) {
      return;
    }
    const [index, item] = claimed.value;
    results[index] = await fn(item, index);
    await worker();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

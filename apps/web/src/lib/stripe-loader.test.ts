import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoadStripe = vi.fn();
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: (...args: unknown[]) => mockLoadStripe(...args),
}));

import { getStripe } from './stripe-loader';

describe('getStripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadStripe.mockImplementation((key: string) => Promise.resolve({ key }));
  });

  // Each test uses a UNIQUE key — the loader's Map cache is module-level state that outlives
  // `vi.clearAllMocks()`, so reusing a key across tests would hit an earlier test's cache entry.

  it('calls loadStripe with the publishable key', async () => {
    await getStripe('pk_test_unique_1');
    expect(mockLoadStripe).toHaveBeenCalledWith('pk_test_unique_1');
  });

  it('memoises per key — a second call for the SAME key does not call loadStripe again', async () => {
    await getStripe('pk_test_unique_2');
    await getStripe('pk_test_unique_2');
    expect(mockLoadStripe).toHaveBeenCalledTimes(1);
  });

  it('calls loadStripe again for a DIFFERENT key', async () => {
    await getStripe('pk_test_unique_3');
    await getStripe('pk_test_unique_4');
    expect(mockLoadStripe).toHaveBeenCalledTimes(2);
  });
});

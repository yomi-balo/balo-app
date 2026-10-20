import { expect, it } from 'vitest';

it('BAL-605 throwaway: a failing test in one shard must fail Unit Tests', () => {
  expect(1).toBe(2);
});

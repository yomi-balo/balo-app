import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-534 fix round F8 — `admin/page.tsx` had no test, and was 0% covered. It renders nothing:
 * assert it unconditionally redirects to the one real admin surface this ticket ships, following
 * the `admin/layout.test.tsx` mock pattern.
 */
const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn(() => {
    throw new Error('REDIRECT');
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

import AdminPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
});

describe('AdminPage (BAL-534)', () => {
  it('redirects to /admin/catalogue', () => {
    expect(() => AdminPage()).toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/admin/catalogue');
    expect(mockRedirect).toHaveBeenCalledTimes(1);
  });
});

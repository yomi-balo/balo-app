import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@/test/utils';

const { mockReplace, mockOpen, modal, searchParams } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockOpen: vi.fn(),
  modal: { isOpen: false, closeReason: null as 'dismissed' | 'success' | null },
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => searchParams,
}));

vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({
    open: mockOpen,
    isOpen: modal.isOpen,
    closeReason: modal.closeReason,
  }),
}));

import LoginPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  modal.isOpen = false;
  modal.closeReason = null;
});

describe('LoginPage — deterministic dismiss/success (BAL-361)', () => {
  it('opens the auth modal on mount', () => {
    render(<LoginPage />);
    expect(mockOpen).toHaveBeenCalled();
  });

  it('bounces to / on a genuine dismiss after the modal opened', () => {
    modal.isOpen = true;
    const { rerender } = render(<LoginPage />);
    expect(mockReplace).not.toHaveBeenCalled();

    modal.isOpen = false;
    modal.closeReason = 'dismissed';
    rerender(<LoginPage />);

    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('does NOT bounce on success', () => {
    modal.isOpen = true;
    const { rerender } = render(<LoginPage />);

    modal.isOpen = false;
    modal.closeReason = 'success';
    rerender(<LoginPage />);

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ignores a stale closed state when the modal never opened on this page', () => {
    modal.isOpen = false;
    modal.closeReason = 'dismissed';
    render(<LoginPage />);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

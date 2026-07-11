import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@/test/utils';

// Shared mutable modal state + spies (hoisted so the vi.mock factories can close over them).
const { mockReplace, mockOpenSignup, modal } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockOpenSignup: vi.fn(),
  modal: { isOpen: false, closeReason: null as 'dismissed' | 'success' | null },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({
    openSignup: mockOpenSignup,
    isOpen: modal.isOpen,
    closeReason: modal.closeReason,
  }),
}));

import SignUpPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  modal.isOpen = false;
  modal.closeReason = null;
});

describe('SignUpPage — deterministic dismiss/success (BAL-361)', () => {
  it('opens the signup modal on mount', () => {
    render(<SignUpPage />);
    expect(mockOpenSignup).toHaveBeenCalled();
  });

  it('bounces to / on a genuine dismiss after the modal opened', () => {
    modal.isOpen = true;
    const { rerender } = render(<SignUpPage />);
    // Opened here first → no bounce yet.
    expect(mockReplace).not.toHaveBeenCalled();

    modal.isOpen = false;
    modal.closeReason = 'dismissed';
    rerender(<SignUpPage />);

    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('does NOT bounce on success — the auth step owns the /onboarding navigation', () => {
    modal.isOpen = true;
    const { rerender } = render(<SignUpPage />);

    modal.isOpen = false;
    modal.closeReason = 'success';
    rerender(<SignUpPage />);

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('ignores a stale closed state when the modal never opened on this page', () => {
    // Arrive already-closed with a leftover reason and no open-here transition.
    modal.isOpen = false;
    modal.closeReason = 'dismissed';
    render(<SignUpPage />);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as Sentry from '@sentry/nextjs';
import { SessionSyncRedirect, SESSION_SYNC_HOPS_KEY } from './session-sync-redirect';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

const SYNC_URL = '/api/auth/session-sync?returnTo=%2Fcases%2Fabc%3Ftab%3Dfiles';

describe('SessionSyncRedirect', () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    replace.mockClear();
    vi.mocked(Sentry.captureMessage).mockClear();
    sessionStorage.clear();
    vi.stubGlobal('location', { pathname: '/cases/abc', search: '?tab=files', replace });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hard-navigates to session-sync with the current path and query as returnTo', () => {
    render(<SessionSyncRedirect />);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(SYNC_URL);
  });

  it('navigates exactly once under StrictMode double-invoked effects', () => {
    render(
      <StrictMode>
        <SessionSyncRedirect />
      </StrictMode>
    );
    expect(replace).toHaveBeenCalledOnce();
  });

  it('shows a visible status caption', () => {
    render(<SessionSyncRedirect />);
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing your session…');
    expect(screen.getByText('Refreshing your session…')).not.toHaveClass('sr-only');
  });

  it('offers a plain-anchor retry only after 10 seconds', () => {
    render(<SessionSyncRedirect />);
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', SYNC_URL);
  });

  describe('loop breaker', () => {
    const seed = (stamps: number[]): void =>
      sessionStorage.setItem(SESSION_SYNC_HOPS_KEY, JSON.stringify(stamps));

    it('records the first hop and navigates', () => {
      render(<SessionSyncRedirect />);
      expect(replace).toHaveBeenCalledOnce();
      const stored: unknown = JSON.parse(sessionStorage.getItem(SESSION_SYNC_HOPS_KEY) ?? '[]');
      expect(stored).toHaveLength(1);
    });

    it('stops navigating and shows the retry immediately after two recent hops', () => {
      const now = Date.now();
      seed([now - 5_000, now - 1_000]);
      render(<SessionSyncRedirect />);
      expect(replace).not.toHaveBeenCalled();
      expect(screen.getByText('This is taking longer than usual.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute('href', SYNC_URL);
      expect(Sentry.captureMessage).toHaveBeenCalledOnce();
      expect(Sentry.captureMessage).toHaveBeenCalledWith('Session sync did not converge', {
        level: 'warning',
        extra: { hops: 2, pathname: '/cases/abc' },
      });
    });

    it('ignores hops older than the window', () => {
      const now = Date.now();
      seed([now - 60_000, now - 31_000]);
      render(<SessionSyncRedirect />);
      expect(replace).toHaveBeenCalledOnce();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it('still navigates when storage reads throw', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      expect(() => render(<SessionSyncRedirect />)).not.toThrow();
      expect(replace).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    });

    it('clears the budget when Try again is clicked', () => {
      const now = Date.now();
      seed([now - 2_000, now - 1_000]);
      render(<SessionSyncRedirect />);
      fireEvent.click(screen.getByRole('link', { name: 'Try again' }));
      expect(sessionStorage.getItem(SESSION_SYNC_HOPS_KEY)).toBeNull();
    });
  });
});

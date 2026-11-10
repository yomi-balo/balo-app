import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SessionSyncRedirect } from './session-sync-redirect';

const SYNC_URL = '/api/auth/session-sync?returnTo=%2Fcases%2Fabc%3Ftab%3Dfiles';

describe('SessionSyncRedirect', () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    replace.mockClear();
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
});
